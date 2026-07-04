#!/usr/bin/env bash
# install.sh — Set up PR Controller on macOS.
#
# Usage:
#   scripts/install.sh                # install server agent (recommended)
#   scripts/install.sh --with-poller  # also install standalone poll agent
#   scripts/install.sh --uninstall    # remove all agents
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PYTHON="$(command -v python3 || true)"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
STATE_DIR="$HOME/.pr-controller"
CONFIG_SRC="$PROJECT_DIR/config.yaml"
CONFIG_DST="$STATE_DIR/config.yaml"

SERVE_TEMPLATE="$PROJECT_DIR/launchd/com.prcontroller.serve.plist"
POLL_TEMPLATE="$PROJECT_DIR/launchd/com.prcontroller.poll.plist"
SERVE_PLIST="$LAUNCH_AGENTS/com.prcontroller.serve.plist"
POLL_PLIST="$LAUNCH_AGENTS/com.prcontroller.poll.plist"

# ── Helpers ───────────────────────────────────────────────────────────────────
info()  { echo "  $*"; }
ok()    { echo "✓ $*"; }
warn()  { echo "⚠  $*"; }
die()   { echo "✗ ERROR: $*" >&2; exit 1; }

generate_plist() {
  local template="$1" dest="$2"
  sed \
    -e "s|__PYTHON__|$PYTHON|g" \
    -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
    -e "s|__HOME__|$HOME|g" \
    "$template" > "$dest"
}

load_agent() {
  local plist="$1" label="$2"
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load "$plist"
  ok "Loaded launchd agent: $label"
}

unload_agent() {
  local plist="$1" label="$2"
  if launchctl unload "$plist" 2>/dev/null; then
    ok "Unloaded: $label"
  fi
  rm -f "$plist"
}

# ── Uninstall ─────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--uninstall" ]]; then
  echo "Uninstalling PR Controller…"
  unload_agent "$SERVE_PLIST" "com.prcontroller.serve" || true
  unload_agent "$POLL_PLIST"  "com.prcontroller.poll"  || true
  echo "Done. State files in $STATE_DIR were kept (remove manually if desired)."
  exit 0
fi

# ── Preflight checks ──────────────────────────────────────────────────────────
echo "=== PR Controller — Setup ==="
echo ""
info "Project : $PROJECT_DIR"
info "Python  : ${PYTHON:-not found}"
echo ""

[[ -n "$PYTHON" ]] || die "python3 not found. Install via 'brew install python' or Xcode tools."
command -v gh >/dev/null 2>&1 || die "'gh' (GitHub CLI) not found. Install with: brew install gh"
gh auth status >/dev/null 2>&1 || die "gh not authenticated. Run: gh auth login"

# ── State directory & config ──────────────────────────────────────────────────
mkdir -p "$STATE_DIR" "$LAUNCH_AGENTS"

if [[ ! -f "$CONFIG_DST" ]]; then
  cp "$CONFIG_SRC" "$CONFIG_DST"
  ok "Config copied to $CONFIG_DST"
  warn "Edit $CONFIG_DST to set your repo name before the server starts."
else
  ok "Config already exists at $CONFIG_DST"
fi

# ── Python dependencies ───────────────────────────────────────────────────────
echo ""
echo "Installing Python dependencies…"
"$PYTHON" -m pip install -r "$PROJECT_DIR/requirements.txt" --quiet
ok "Dependencies installed"

# ── Optional: terminal-notifier (click-to-open notifications) ────────────────
if command -v terminal-notifier >/dev/null 2>&1; then
  ok "terminal-notifier found — clicking notifications will open the dashboard"
else
  warn "terminal-notifier not installed."
  info "For click-to-open notifications, run:  brew install terminal-notifier"
  info "(Notifications still appear without it; clicking them just won't navigate.)"
fi

# ── Server launchd agent ──────────────────────────────────────────────────────
echo ""
echo "Installing launchd agent (server)…"
generate_plist "$SERVE_TEMPLATE" "$SERVE_PLIST"
load_agent "$SERVE_PLIST" "com.prcontroller.serve"

# ── Optional standalone poller ────────────────────────────────────────────────
if [[ "${1:-}" == "--with-poller" ]]; then
  echo ""
  echo "Installing launchd agent (poller)…"
  generate_plist "$POLL_TEMPLATE" "$POLL_PLIST"
  load_agent "$POLL_PLIST" "com.prcontroller.poll"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "=== Done ==="
echo ""
info "Server will start automatically on login."
info "Opening http://127.0.0.1:8765 in 4 seconds…"
info "(The server needs ~3 s to warm up on first run.)"
sleep 4
open "http://127.0.0.1:8765"
