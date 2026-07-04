"""Entry point: python -m pr_controller [serve|poll]"""
import logging
import os
import sys
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(message)s",
    datefmt="%H:%M:%S",
)


def _load_config() -> dict:
    import yaml

    candidates = [
        os.environ.get("PRCTL_CONFIG"),
        Path.home() / ".pr-controller" / "config.yaml",
        Path(__file__).parent.parent / "config.yaml",
    ]
    for path in candidates:
        if path and Path(path).exists():
            with open(path) as f:
                return yaml.safe_load(f)
    raise FileNotFoundError(
        "config.yaml not found.\n"
        "Either place it at ~/.pr-controller/config.yaml, "
        "in the project root, or set PRCTL_CONFIG=/path/to/config.yaml."
    )


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "serve"

    if cmd in ("-h", "--help"):
        print("Usage: python -m pr_controller [serve|poll]")
        print("  serve  Start the web server (default)")
        print("  poll   Run one poll cycle and exit")
        return

    try:
        config = _load_config()
    except FileNotFoundError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    if cmd == "serve":
        from .server import run_server
        run_server(config)

    elif cmd == "poll":
        from .poller import poll
        events, prs = poll(config)
        if prs is None:
            print("Poll skipped — another poll is already running.")
            return
        print(f"Poll complete — {len(prs)} open PRs, {len(events)} new event(s).")
        for ev in events:
            print(f"  [{ev['type']:20s}] PR #{ev['pr_number']}: {ev.get('snippet', '')[:80]}")

    else:
        print(f"Unknown command: {cmd!r}. Use 'serve' or 'poll'.", file=sys.stderr)
        sys.exit(1)


main()
