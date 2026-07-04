"""Poll GitHub for PR activity and emit typed events."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from urllib.parse import quote

from .github_client import (
    enrich_email_cache,
    extract_emails_from_nodes,
    fetch_prs,
    get_my_login,
)
from .notifier import notify
from .parser import compute
from .state import (
    PollLock,
    append_events,
    load_email_cache,
    load_state,
    save_email_cache,
    save_state,
)

log = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _snippet(text: str) -> str:
    """Short preview for notifications (140 chars)."""
    return " ".join((text or "").split())[:140]


def _body(text: str) -> str:
    """Full comment body; generous cap keeps events.json bounded without truncating normal reviews."""
    return (text or "").strip()[:32000]


def _local_url(config: dict, event_id: str) -> str:
    host = config.get("server", {}).get("host", "127.0.0.1")
    port = config.get("server", {}).get("port", 8765)
    return f"http://{host}:{port}/?event={quote(event_id, safe='')}"


def poll(config: dict) -> tuple[list[dict] | None, list[dict] | None]:
    """Run one poll cycle. Returns (new_events, current_prs).

    When another poll holds the lock, returns (None, None) so callers keep their
    existing cache instead of treating an empty list as fresh data.

    Uses a file lock so concurrent runs (background thread + launchd) are safe.
    """
    try:
        with PollLock():
            return _do_poll(config)
    except BlockingIOError:
        log.info("Poll already running; skipping this cycle.")
        return None, None


def _do_poll(config: dict) -> tuple[list[dict], list[dict]]:
    github_cfg = config.get("github", {})
    author_filter = github_cfg.get("author_filter", "@me")
    notif_cfg = config.get("notifications", {})
    allowed_types = set(
        notif_cfg.get("types", ["new_comment", "reply", "ci_fail", "approved", "changes_requested"])
    )
    quiet_hours = notif_cfg.get("quiet_hours")

    my_login = get_my_login()
    raw = fetch_prs(author_filter)
    valid_nodes = [n for n in raw["data"]["search"]["nodes"] if n]
    prs = compute(valid_nodes)
    raw_by_num = {n["number"]: n for n in valid_nodes}

    state = load_state()
    seen_comments: set[str] = set(state.get("seen_comment_ids", []))
    seen_reviews: set[str] = set(state.get("seen_review_ids", []))
    ci_states: dict[str, str] = state.get("ci_states", {})
    approval_states: dict[str, list[str]] = state.get("approval_states", {})
    baseline_done: bool = state.get("baseline_done", False)

    new_events: list[dict] = []
    new_seen_comments: set[str] = set()
    new_seen_reviews: set[str] = set()
    new_ci_states: dict[str, str] = dict(ci_states)
    new_approval_states: dict[str, set[str]] = {k: set(v) for k, v in approval_states.items()}

    for pr_data in prs:
        pr_num = pr_data["number"]
        pr_num_str = str(pr_num)
        pr_url = pr_data["url"]
        pr_title = pr_data["title"]
        raw_pr = raw_by_num.get(pr_num, {})

        # ── Inline review-thread comments (new_comment / reply) ─────────────
        for thread in (raw_pr.get("reviewThreads") or {}).get("nodes", []):
            comments = (thread.get("comments") or {}).get("nodes", [])
            my_indices = [
                i for i, c in enumerate(comments)
                if (c.get("author") or {}).get("login") == my_login
            ]
            for idx, comment in enumerate(comments):
                cid = comment["id"]
                new_seen_comments.add(cid)
                if cid in seen_comments:
                    continue
                author = (comment.get("author") or {}).get("login", "unknown")
                if author == my_login or not baseline_done:
                    continue
                is_reply = any(j < idx for j in my_indices)
                event_type = "reply" if is_reply else "new_comment"
                event_id = f"{event_type}:{pr_num}:{cid}"
                full_body = comment.get("bodyText", "")
                new_events.append({
                    "id": event_id,
                    "type": event_type,
                    "pr_number": pr_num,
                    "pr_title": pr_title,
                    "author": author,
                    "body": _body(full_body),
                    "snippet": _snippet(full_body),
                    "github_url": comment.get("url") or pr_url,
                    "url": comment.get("url") or pr_url,
                    "local_url": _local_url(config, event_id),
                    "at": _now_iso(),
                })

        # ── Top-level review body comments ───────────────────────────────────
        for review in (raw_pr.get("reviews") or {}).get("nodes", []):
            rid = review.get("id") or ""
            new_seen_reviews.add(rid)
            if rid in seen_reviews:
                continue
            author = (review.get("author") or {}).get("login", "unknown")
            full_body = (review.get("body") or "").strip()
            if author == my_login or not full_body or not baseline_done:
                continue
            event_id = f"new_comment:{pr_num}:{rid}"
            new_events.append({
                "id": event_id,
                "type": "new_comment",
                "pr_number": pr_num,
                "pr_title": pr_title,
                "author": author,
                "body": _body(full_body),
                "snippet": _snippet(full_body),
                "github_url": review.get("url") or pr_url,
                "url": review.get("url") or pr_url,
                "local_url": _local_url(config, event_id),
                "at": _now_iso(),
            })

        # ── CI failure regression ────────────────────────────────────────────
        curr_ci = pr_data["ci"]
        prev_ci = ci_states.get(pr_num_str)
        new_ci_states[pr_num_str] = curr_ci
        if baseline_done and prev_ci and prev_ci != "fail" and curr_ci == "fail":
            event_id = f"ci_fail:{pr_num}:{_now_iso()}"
            fail_names = ", ".join(f["name"] for f in pr_data["build_fails"])[:140]
            new_events.append({
                "id": event_id,
                "type": "ci_fail",
                "pr_number": pr_num,
                "pr_title": pr_title,
                "author": "",
                "body": fail_names,
                "snippet": fail_names,
                "github_url": pr_url,
                "url": pr_url,
                "local_url": _local_url(config, event_id),
                "at": _now_iso(),
            })

        # ── New approvals ────────────────────────────────────────────────────
        curr_approvers = set(pr_data["approvers"])
        prev_approvers = new_approval_states.get(pr_num_str, set())
        new_approval_states[pr_num_str] = curr_approvers
        if baseline_done:
            for new_approver in curr_approvers - prev_approvers:
                event_id = f"approved:{pr_num}:{new_approver}"
                text = f"@{new_approver} approved PR #{pr_num}"
                new_events.append({
                    "id": event_id,
                    "type": "approved",
                    "pr_number": pr_num,
                    "pr_title": pr_title,
                    "author": new_approver,
                    "body": text,
                    "snippet": text,
                    "github_url": pr_url,
                    "url": pr_url,
                    "local_url": _local_url(config, event_id),
                    "at": _now_iso(),
                })

        # ── Changes requested ────────────────────────────────────────────────
        if baseline_done:
            for requester in pr_data["change_requesters"]:
                marker = f"cr:{pr_num_str}:{requester}"
                new_seen_reviews.add(marker)
                if marker not in seen_reviews:
                    event_id = f"changes_requested:{pr_num}:{requester}"
                    text = f"@{requester} requested changes on PR #{pr_num}"
                    new_events.append({
                        "id": event_id,
                        "type": "changes_requested",
                        "pr_number": pr_num,
                        "pr_title": pr_title,
                        "author": requester,
                        "body": text,
                        "snippet": text,
                        "github_url": pr_url,
                        "url": pr_url,
                        "local_url": _local_url(config, event_id),
                        "at": _now_iso(),
                    })

    # ── Update email cache ───────────────────────────────────────────────────
    _update_email_cache(valid_nodes)

    # Persist updated state
    state["seen_comment_ids"] = list(seen_comments | new_seen_comments)
    state["seen_review_ids"] = list(seen_reviews | new_seen_reviews)
    state["ci_states"] = new_ci_states
    state["approval_states"] = {k: list(v) for k, v in new_approval_states.items()}
    state["baseline_done"] = True
    save_state(state)

    # Filter to allowed types and persist events
    emitted = [e for e in new_events if e["type"] in allowed_types]
    append_events(emitted)

    # Send macOS notifications
    if notif_cfg.get("enabled", True):
        for event in emitted:
            _send_notification(event, quiet_hours)

    log.info("Poll complete: %d new events (baseline_done was %s)", len(emitted), baseline_done)
    return emitted, prs


def _update_email_cache(valid_nodes: list) -> None:
    """Merge newly discovered emails into the email cache, REST-fetching unknowns."""
    cache = load_email_cache()

    # 1. Collect emails already embedded in the GraphQL response
    inline = extract_emails_from_nodes(valid_nodes)
    cache.update(inline)

    # 2. For logins whose email is unknown, try REST lookup (capped at 15/cycle)
    all_logins = set()
    for pr in valid_nodes:
        if not pr:
            continue
        for review in (pr.get("reviews") or {}).get("nodes", []):
            login = (review.get("author") or {}).get("login")
            if login:
                all_logins.add(login)
        for review in (pr.get("latestOpinionatedReviews") or {}).get("nodes", []):
            login = (review.get("author") or {}).get("login")
            if login:
                all_logins.add(login)
        for thread in (pr.get("reviewThreads") or {}).get("nodes", []):
            for comment in (thread.get("comments") or {}).get("nodes", []):
                login = (comment.get("author") or {}).get("login")
                if login:
                    all_logins.add(login)

    missing = [l for l in all_logins if l not in cache]
    if missing:
        updates = enrich_email_cache(missing, cache)
        cache.update(updates)

    save_email_cache(cache)


def _send_notification(event: dict, quiet_hours: dict | None) -> None:
    t = event["type"]
    pr_num = event["pr_number"]
    author = event.get("author", "")
    snippet = event.get("snippet", "") or event.get("pr_title", "")

    titles = {
        "new_comment": f"PR #{pr_num} — @{author} commented" if author else f"PR #{pr_num} — new comment",
        "reply": f"PR #{pr_num} — @{author} replied",
        "approved": f"PR #{pr_num} — approved by @{author}",
        "ci_fail": f"PR #{pr_num} — CI failed",
        "changes_requested": f"PR #{pr_num} — @{author} requested changes",
    }
    title = titles.get(t, f"PR #{pr_num} — {t}")
    notify(
        title,
        snippet,
        github_url=event.get("github_url") or event.get("url"),
        local_url=event.get("local_url"),
        quiet_hours=quiet_hours,
    )
