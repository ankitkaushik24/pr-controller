"""Slack Workflow webhook integration."""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request

from .state import STATE_DIR

_SECRETS_FILE = STATE_DIR / "slack.json"
_WEBHOOK_RE = re.compile(r"^https://hooks\.slack\.com/(triggers|workflows)/")


def _ensure_dir() -> None:
    STATE_DIR.mkdir(exist_ok=True)


def load_config() -> dict:
    """Return {"webhook_url": "..."} or {} if not configured."""
    _ensure_dir()
    if _SECRETS_FILE.exists():
        return json.loads(_SECRETS_FILE.read_text())
    return {}


def save_config(webhook_url: str) -> None:
    """Validate and persist the webhook URL with owner-only permissions."""
    webhook_url = webhook_url.strip()
    if not _WEBHOOK_RE.match(webhook_url):
        raise ValueError(
            "URL must start with https://hooks.slack.com/triggers/ or /workflows/. "
            "Generate it in Slack → Automations → New Workflow → From a webhook."
        )
    _ensure_dir()
    _SECRETS_FILE.write_text(json.dumps({"webhook_url": webhook_url}))
    _SECRETS_FILE.chmod(0o600)


def delete_config() -> None:
    _SECRETS_FILE.unlink(missing_ok=True)


def masked_url(url: str) -> str:
    """Return a display-safe preview of the URL (never the full token)."""
    if not url:
        return ""
    match = _WEBHOOK_RE.match(url)
    if match:
        prefix = match.group(0)
        secret = url[len(prefix):]
        if len(secret) <= 8:
            return f"{prefix}{'*' * len(secret)}"
        return f"{prefix}{secret[:4]}...{secret[-4:]}"
    if len(url) <= 20:
        return f"{url[:8]}..."
    return f"{url[:16]}...{url[-4:]}"


def send_message(webhook_url: str, payload: dict) -> None:
    """POST payload as JSON to a Slack Workflow webhook. Raises on HTTP error."""
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        webhook_url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status >= 300:
                raise RuntimeError(f"Slack returned HTTP {resp.status}")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")[:200]
        raise RuntimeError(f"HTTP {exc.code}: {body}") from exc
