"""macOS native notifications via osascript (or terminal-notifier if installed).

Click-to-open behavior:
  - terminal-notifier (brew install terminal-notifier): opens local_url in browser,
    which lands on the dashboard with the event highlighted.  Preferred.
  - osascript fallback: shows the GitHub URL as subtitle only; no click action.
"""
from __future__ import annotations

import shutil
import subprocess
from datetime import datetime


def _in_quiet_hours(quiet_hours: dict) -> bool:
    if not quiet_hours:
        return False
    now = datetime.now()
    sh, sm = map(int, quiet_hours.get("start", "00:00").split(":"))
    eh, em = map(int, quiet_hours.get("end", "00:00").split(":"))
    current = now.hour * 60 + now.minute
    start = sh * 60 + sm
    end = eh * 60 + em
    if start <= end:
        return start <= current < end
    return current >= start or current < end  # overnight window


def _esc(s: str) -> str:
    return str(s).replace("\\", "\\\\").replace('"', '\\"')


def notify(
    title: str,
    message: str,
    *,
    github_url: str | None = None,
    local_url: str | None = None,
    quiet_hours: dict | None = None,
) -> None:
    """Send a macOS notification.

    Prefers local_url for click-to-open (lands on dashboard with event highlighted).
    Falls back to github_url, then no-click osascript.
    """
    if quiet_hours and _in_quiet_hours(quiet_hours):
        return

    msg = (message or "")[:256]
    click_url = local_url or github_url  # local_url brings user back to dashboard

    if click_url and shutil.which("terminal-notifier"):
        subprocess.run(
            [
                "terminal-notifier",
                "-title", title,
                "-message", msg,
                "-open", click_url,
                "-activate", "com.google.Chrome",
            ],
            capture_output=True,
        )
        return

    # Fallback: osascript (always available but no click action)
    subtitle = f' subtitle "{_esc(github_url or "")}"' if github_url else ""
    script = f'display notification "{_esc(msg)}" with title "{_esc(title)}"{subtitle}'
    subprocess.run(["osascript", "-e", script], capture_output=True)
