"""Flask server: dashboard UI, REST API, and SSE event stream."""
from __future__ import annotations

import json
import logging
import queue
import threading
import time
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context

from . import slack as slack_module
from . import state as state_module
from .github_client import reply_to_review_thread, resolve_review_threads
from .parser import buckets
from .poller import poll

log = logging.getLogger(__name__)

_STATIC_DIR = str(Path(__file__).parent / "static")
app = Flask(__name__, static_folder=_STATIC_DIR, static_url_path="/static")
app.config["PROPAGATE_EXCEPTIONS"] = True

# ── Shared server state (written from background thread, read from request threads) ──
_config: dict = {}
_cached_prs: list[dict] = []
_cached_at: str = ""
_cache_lock = threading.Lock()

# ── SSE client registry ──────────────────────────────────────────────────────
_sse_queues: list[queue.Queue] = []
_sse_lock = threading.Lock()


def _broadcast(event: dict) -> None:
    with _sse_lock:
        for q in list(_sse_queues):
            try:
                q.put_nowait(event)
            except queue.Full:
                pass


def _filter_dismissed_conversation_comments(prs: list[dict]) -> list[dict]:
    """Hide locally dismissed conversation comments from PR payloads."""
    dismissed = state_module.dismissed_comment_ids()
    if not dismissed:
        return prs
    for pr in prs:
        comments = pr.get("conversation_comments") or []
        pr["conversation_comments"] = [
            comment
            for comment in comments
            if comment.get("comment_id") not in dismissed
        ]
    return prs


def _update_cache(prs: list[dict]) -> None:
    global _cached_prs, _cached_at
    filtered = _filter_dismissed_conversation_comments(prs)
    with _cache_lock:
        _cached_prs = filtered
        _cached_at = datetime.now(timezone.utc).isoformat()
        generated_at = _cached_at
        count = len(filtered)
    _broadcast({"type": "prs_updated", "generated_at": generated_at, "count": count})


def _cached_snapshot() -> tuple[list[dict], str]:
    with _cache_lock:
        return list(_cached_prs), _cached_at


def _remove_resolved_from_cache(thread_ids: list[str]) -> tuple[list[dict], str]:
    """Drop resolved threads from the in-memory PR cache and broadcast an update."""
    global _cached_prs, _cached_at
    resolved = set(thread_ids)
    with _cache_lock:
        for pr in _cached_prs:
            pr["unresolved"] = [
                comment
                for comment in pr.get("unresolved", [])
                if comment.get("thread_id") not in resolved
            ]
        _cached_at = datetime.now(timezone.utc).isoformat()
        prs = list(_cached_prs)
        generated_at = _cached_at
    _broadcast({"type": "prs_updated", "generated_at": generated_at, "count": len(prs)})
    return prs, generated_at


def _remove_dismissed_from_cache(comment_ids: list[str]) -> tuple[list[dict], str]:
    """Drop dismissed conversation comments from the in-memory PR cache."""
    global _cached_prs, _cached_at
    dismissed = set(comment_ids)
    with _cache_lock:
        for pr in _cached_prs:
            pr["conversation_comments"] = [
                comment
                for comment in pr.get("conversation_comments") or []
                if comment.get("comment_id") not in dismissed
            ]
        _cached_at = datetime.now(timezone.utc).isoformat()
        prs = list(_cached_prs)
        generated_at = _cached_at
    _broadcast({"type": "prs_updated", "generated_at": generated_at, "count": len(prs)})
    return prs, generated_at


def _append_reply_to_cache(thread_id: str, reply: dict) -> tuple[list[dict], str]:
    """Append a posted reply onto the matching unresolved thread in cache."""
    global _cached_prs, _cached_at
    with _cache_lock:
        for pr in _cached_prs:
            for comment in pr.get("unresolved", []):
                if comment.get("thread_id") != thread_id:
                    continue
                replies = comment.setdefault("replies", [])
                reply_id = reply.get("comment_id") or ""
                if reply_id and any(r.get("comment_id") == reply_id for r in replies):
                    break
                replies.append(reply)
                break
        _cached_at = datetime.now(timezone.utc).isoformat()
        prs = list(_cached_prs)
        generated_at = _cached_at
    _broadcast({"type": "prs_updated", "generated_at": generated_at, "count": len(prs)})
    return prs, generated_at


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/prs")
def api_prs():
    with _cache_lock:
        prs = list(_cached_prs)
        at = _cached_at
    return jsonify({"prs": prs, "summary": buckets(prs), "generated_at": at})


@app.route("/api/refresh", methods=["POST"])
def api_refresh():
    try:
        new_events, prs = poll(_config)
        if prs is None:
            with _cache_lock:
                cached_prs = list(_cached_prs)
                cached_at = _cached_at
            return jsonify({
                "prs": cached_prs,
                "summary": buckets(cached_prs),
                "generated_at": cached_at,
                "new_events": 0,
                "skipped": True,
            })
        _update_cache(prs)
        for ev in new_events:
            _broadcast(ev)
        return jsonify({
            "prs": prs,
            "summary": buckets(prs),
            "generated_at": _cached_at,
            "new_events": len(new_events),
            "skipped": False,
        })
    except Exception as exc:
        log.exception("Refresh failed")
        return jsonify({"error": str(exc)}), 500


@app.route("/api/events")
def api_events():
    """Server-Sent Events stream. Each connected browser tab gets its own queue."""
    client_q: queue.Queue = queue.Queue(maxsize=100)
    with _sse_lock:
        _sse_queues.append(client_q)

    def event_stream():
        yield f"data: {json.dumps({'type': 'connected'})}\n\n"
        try:
            while True:
                try:
                    event = client_q.get(timeout=25)
                    yield f"data: {json.dumps(event)}\n\n"
                except queue.Empty:
                    # Keep-alive heartbeat so the browser doesn't time out
                    yield 'data: {"type":"heartbeat"}\n\n'
        finally:
            with _sse_lock:
                try:
                    _sse_queues.remove(client_q)
                except ValueError:
                    pass

    return Response(
        stream_with_context(event_stream()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/api/events/history")
def api_events_history():
    limit = min(int(request.args.get("limit", 50)), 200)
    events = state_module.load_events()
    return jsonify(list(reversed(events[-limit:])))


# ── Reviewer email suggestions ────────────────────────────────────────────────

@app.route("/api/reviewers")
def api_reviewers():
    """Return {login, email} pairs from the local email cache for auto-suggestions."""
    cache = state_module.load_email_cache()
    reviewers = [
        {"login": login, "email": email}
        for login, email in cache.items()
        if email
    ]
    reviewers.sort(key=lambda r: r["login"])
    return jsonify(reviewers)


# ── Review thread actions ─────────────────────────────────────────────────────

@app.route("/api/threads/reply", methods=["POST"])
def api_thread_reply():
    body = request.get_json(silent=True) or {}
    thread_id = (body.get("thread_id") or "").strip()
    reply_body = (body.get("body") or "").strip()
    if not thread_id:
        return jsonify({"error": "thread_id is required"}), 400
    if not reply_body:
        return jsonify({"error": "Reply body cannot be empty"}), 400
    try:
        comment = reply_to_review_thread(thread_id, reply_body)
        full_body = comment.get("bodyText") or reply_body
        reply = {
            "comment_id": comment.get("id") or "",
            "author": ((comment.get("author") or {}).get("login") or ""),
            "body": full_body,
            "snippet": " ".join(full_body.split())[:140],
            "url": comment.get("url") or "",
            "created_at": "",
        }
        prs, generated_at = _append_reply_to_cache(thread_id, reply)
        return jsonify({
            "ok": True,
            "comment": {
                "id": reply["comment_id"],
                "url": reply["url"],
                "body": reply["body"],
                "author": reply["author"],
                "snippet": reply["snippet"],
            },
            "prs": prs,
            "summary": buckets(prs),
            "generated_at": generated_at,
        })
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        log.exception("Failed to reply to review thread %s", thread_id)
        return jsonify({"error": str(exc)}), 500


@app.route("/api/threads/resolve", methods=["POST"])
def api_threads_resolve():
    body = request.get_json(silent=True) or {}
    thread_ids = body.get("thread_ids") or []
    if isinstance(body.get("thread_id"), str) and body.get("thread_id").strip():
        thread_ids = [body["thread_id"], *thread_ids]
    if not isinstance(thread_ids, list) or not thread_ids:
        return jsonify({"error": "thread_ids is required"}), 400
    cleaned = [str(tid).strip() for tid in thread_ids if str(tid).strip()]
    if not cleaned:
        return jsonify({"error": "thread_ids is required"}), 400
    try:
        result = resolve_review_threads(cleaned)
        prs, generated_at = _cached_snapshot()
        if result["resolved"]:
            prs, generated_at = _remove_resolved_from_cache(result["resolved"])
        return jsonify({
            "ok": not result["errors"],
            "resolved": result["resolved"],
            "errors": result["errors"],
            "prs": prs,
            "summary": buckets(prs),
            "generated_at": generated_at,
        })
    except Exception as exc:
        log.exception("Failed to resolve review threads")
        return jsonify({"error": str(exc)}), 500


@app.route("/api/comments/dismiss", methods=["POST"])
def api_comments_dismiss():
    """Locally hide conversation comments from the dashboard (does not change GitHub)."""
    body = request.get_json(silent=True) or {}
    comment_ids = body.get("comment_ids") or []
    if isinstance(body.get("comment_id"), str) and body.get("comment_id").strip():
        comment_ids = [body["comment_id"], *comment_ids]
    if not isinstance(comment_ids, list) or not comment_ids:
        return jsonify({"error": "comment_ids is required"}), 400
    cleaned = [str(cid).strip() for cid in comment_ids if str(cid).strip()]
    if not cleaned:
        return jsonify({"error": "comment_ids is required"}), 400
    try:
        state_module.dismiss_comment_ids(cleaned)
        prs, generated_at = _remove_dismissed_from_cache(cleaned)
        return jsonify({
            "ok": True,
            "dismissed": cleaned,
            "prs": prs,
            "summary": buckets(prs),
            "generated_at": generated_at,
        })
    except Exception as exc:
        log.exception("Failed to dismiss conversation comments")
        return jsonify({"error": str(exc)}), 500


# ── Slack integration ─────────────────────────────────────────────────────────

@app.route("/api/slack/config", methods=["GET", "POST", "DELETE"])
def api_slack_config():
    if request.method == "GET":
        cfg = slack_module.load_config()
        webhook_url = cfg.get("webhook_url", "")
        return jsonify({
            "configured": bool(webhook_url),
            "preview": slack_module.masked_url(webhook_url) if webhook_url else "",
        })

    if request.method == "DELETE":
        slack_module.delete_config()
        return jsonify({"ok": True})

    # POST
    body = request.get_json(silent=True) or {}
    url = (body.get("webhook_url") or "").strip()
    try:
        slack_module.save_config(url)
        return jsonify({"ok": True, "preview": slack_module.masked_url(url)})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/slack/message", methods=["POST"])
def api_slack_message():
    body = request.get_json(silent=True) or {}
    emails: list = body.get("emails", [])
    message: str = (body.get("message") or "").strip()
    pr_number: str = str(body.get("pr_number", ""))
    pr_title: str = body.get("pr_title", "")
    pr_url: str = body.get("pr_url", "")
    event_type: str = body.get("event_type", "custom")

    if not emails:
        return jsonify({"error": "No recipients provided."}), 400
    if not message:
        return jsonify({"error": "Message cannot be empty."}), 400

    cfg = slack_module.load_config()
    webhook_url = cfg.get("webhook_url")
    if not webhook_url:
        return jsonify({"error": "Slack not configured. Add a webhook URL in Settings."}), 400

    sent, errors = 0, []
    for email in emails:
        try:
            slack_module.send_message(webhook_url, {
                "user_email": email,
                "message": message,
                "pr_number": pr_number,
                "pr_title": pr_title,
                "pr_url": pr_url,
                "event_type": event_type,
            })
            sent += 1
        except Exception as exc:
            errors.append(f"{email}: {exc}")
            log.warning("Slack send failed for %s: %s", email, exc)

    return jsonify({"sent": sent, "errors": errors})


# ── Background polling thread ─────────────────────────────────────────────────

def _background_loop(interval_seconds: int) -> None:
    """Background daemon thread: initial baseline poll, then poll every interval."""
    # First cycle: baseline pass (records IDs, no notifications) + initial cache warm
    try:
        log.info("Background poller: initial baseline poll…")
        events, prs = poll(_config)
        if prs is not None:
            _update_cache(prs)
            log.info("Baseline done; %d PRs loaded.", len(prs))
        else:
            log.info("Baseline poll skipped; another poll is already running.")
    except Exception:
        log.exception("Initial poll failed")

    while True:
        time.sleep(interval_seconds)
        try:
            log.info("Background poller: polling…")
            events, prs = poll(_config)
            if prs is None:
                log.info("Poll skipped; another poll is already running.")
                continue
            _update_cache(prs)
            for ev in events:
                _broadcast(ev)
            if events:
                log.info("Broadcast %d new event(s) to SSE clients.", len(events))
        except Exception:
            log.exception("Background poll failed")


# ── Server entry point ────────────────────────────────────────────────────────

def run_server(config: dict) -> None:
    global _config
    _config = config

    interval = config["polling"]["interval_seconds"]
    t = threading.Thread(target=_background_loop, args=(interval,), daemon=True)
    t.start()

    host = config["server"]["host"]
    port = config["server"]["port"]
    url = f"http://{host}:{port}"

    def _open_browser():
        time.sleep(1.5)
        webbrowser.open(url)

    threading.Thread(target=_open_browser, daemon=True).start()

    log.info("PR Controller running at %s", url)
    # use_reloader=False because we manage our own background thread
    app.run(host=host, port=port, threaded=True, use_reloader=False)
