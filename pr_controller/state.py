"""Persistent state: seen comment IDs, event log, and reviewer email cache."""
from __future__ import annotations

import fcntl
import json
from pathlib import Path

STATE_DIR = Path.home() / ".pr-controller"
_STATE_FILE = STATE_DIR / "state.json"
_EVENTS_FILE = STATE_DIR / "events.json"
_LOCK_FILE = STATE_DIR / ".poll.lock"
_EMAIL_CACHE_FILE = STATE_DIR / "email_cache.json"

MAX_EVENTS = 200

_DEFAULT_STATE: dict = {
    "seen_comment_ids": [],
    "seen_review_ids": [],
    "dismissed_comment_ids": [],
    "ci_states": {},
    "approval_states": {},
    "baseline_done": False,
}


def _ensure_dir() -> None:
    STATE_DIR.mkdir(exist_ok=True)


def load_state() -> dict:
    _ensure_dir()
    if _STATE_FILE.exists():
        return json.loads(_STATE_FILE.read_text())
    return dict(_DEFAULT_STATE)


def save_state(state: dict) -> None:
    _ensure_dir()
    _STATE_FILE.write_text(json.dumps(state, indent=2))


def dismissed_comment_ids() -> set[str]:
    """Return locally dismissed conversation comment IDs."""
    return {
        str(comment_id)
        for comment_id in (load_state().get("dismissed_comment_ids") or [])
        if comment_id
    }


def dismiss_comment_ids(comment_ids: list[str]) -> list[str]:
    """Persist dismissed conversation comment IDs; return newly added ones."""
    cleaned = [str(cid).strip() for cid in comment_ids if str(cid).strip()]
    if not cleaned:
        return []
    state = load_state()
    existing = {
        str(comment_id)
        for comment_id in (state.get("dismissed_comment_ids") or [])
        if comment_id
    }
    added = [cid for cid in cleaned if cid not in existing]
    if not added:
        return []
    existing.update(added)
    state["dismissed_comment_ids"] = sorted(existing)
    save_state(state)
    return added


def load_events() -> list[dict]:
    _ensure_dir()
    if _EVENTS_FILE.exists():
        return json.loads(_EVENTS_FILE.read_text())
    return []


def append_events(events: list[dict]) -> None:
    if not events:
        return
    _ensure_dir()
    existing = load_events()
    existing.extend(events)
    if len(existing) > MAX_EVENTS:
        existing = existing[-MAX_EVENTS:]
    _EVENTS_FILE.write_text(json.dumps(existing, indent=2))


def load_email_cache() -> dict[str, str]:
    """Return {github_login: public_email} cache."""
    _ensure_dir()
    if _EMAIL_CACHE_FILE.exists():
        return json.loads(_EMAIL_CACHE_FILE.read_text())
    return {}


def save_email_cache(cache: dict[str, str]) -> None:
    _ensure_dir()
    _EMAIL_CACHE_FILE.write_text(json.dumps(cache, indent=2, sort_keys=True))


class PollLock:
    """File-based exclusive lock to prevent concurrent poll runs."""

    def __init__(self) -> None:
        _ensure_dir()
        self._f = None

    def __enter__(self) -> "PollLock":
        self._f = open(_LOCK_FILE, "w")
        try:
            fcntl.flock(self._f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self._f.close()
            self._f = None
            raise
        return self

    def __exit__(self, *_) -> None:
        if self._f:
            fcntl.flock(self._f, fcntl.LOCK_UN)
            self._f.close()
