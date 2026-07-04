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
from .github_client import fetch_prs
from .parser import buckets, compute
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


def _update_cache(prs: list[dict]) -> None:
    global _cached_prs, _cached_at
    with _cache_lock:
        _cached_prs = prs
        _cached_at = datetime.now(timezone.utc).isoformat()
        generated_at = _cached_at
        count = len(prs)
    _broadcast({"type": "prs_updated", "generated_at": generated_at, "count": count})


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
