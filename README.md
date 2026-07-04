# PR Controller

PR Controller is a local macOS utility that watches your open GitHub pull requests and gives you a browser dashboard for review status, PR activity, native notifications, and Slack follow-ups.

It is intentionally local-first:

- The web UI runs at `http://127.0.0.1:8765`.
- GitHub data is fetched through the authenticated `gh` CLI.
- Background polling runs through a Python server and optional `launchd` agents.
- Slack messages are sent through a Slack Workflow webhook that is stored only on your machine.

## What This App Does

- Shows your open PRs with approvals, unresolved review comments, CI status, and current review state.
- Polls GitHub for new review comments, replies to your comments, CI regressions, approvals, and change requests.
- Sends macOS notifications for new PR activity.
- Opens the dashboard when a clickable notification is selected, when `terminal-notifier` is installed.
- Keeps an activity feed with full comment bodies available from the UI.
- Lets you send Slack Workflow messages to reviewers by email, such as "comments addressed" or "please review this PR".

## Prerequisites

Install and authenticate the required tools:

```sh
brew install gh
gh auth login --hostname github.com --git-protocol https --web
gh auth status
```

Python 3 is also required. It is usually available through macOS Command Line Tools:

```sh
python3 --version
```

Optional but recommended for clickable notifications:

```sh
brew install terminal-notifier
```

Without `terminal-notifier`, notifications still appear through `osascript`, but clicking them will not reliably navigate back to the dashboard.

## First-Time Setup

From the project root:

```sh
cd ~/Projects/pr-controller
python3 -m pip install -r requirements.txt
```

Check `config.yaml` and update the GitHub author filter if needed:

```yaml
github:
  author_filter: "@me"

server:
  host: "127.0.0.1"
  port: 8765
```

Run the app manually:

```sh
python3 -m pr_controller serve
```

Open:

```text
http://127.0.0.1:8765
```

The first poll is a baseline pass. It records existing comments silently so you do not get flooded with old notifications.

## Install As A Login App

To start the server automatically on login:

```sh
scripts/install.sh
```

To also install the standalone interval poller:

```sh
scripts/install.sh --with-poller
```

To remove the launch agents:

```sh
scripts/install.sh --uninstall
```

State files under `~/.pr-controller` are kept during uninstall so you do not lose baseline history or Slack settings.

## Slack Workflow Setup

PR Controller does not call Slack users directly. It sends JSON to a Slack Workflow webhook. Slack Workflow Builder decides where the message goes.

In Slack:

1. Open Automations or Workflow Builder.
2. Create a new workflow.
3. Choose "From a webhook" as the trigger.
4. Define these variables:

```json
{
  "user_email": "text",
  "message": "text",
  "pr_number": "text",
  "pr_title": "text",
  "pr_url": "text",
  "event_type": "text"
}
```

5. Add an action such as "Send a message to a person".
6. Use `user_email` as the recipient and `message` as the message body.
7. Publish the workflow and copy the webhook URL.

In PR Controller:

1. Open the dashboard.
2. Use the Slack settings control.
3. Paste the webhook URL.
4. Send a test or compose a PR follow-up from a PR card/activity item.

Webhook URLs are stored locally in:

```text
~/.pr-controller/slack.json
```

The file is written with owner-only permissions. Do not commit webhook URLs to the repository.

## Daily Usage

Start the server if it is not already running:

```sh
python3 -m pr_controller serve
```

Run one poll cycle from the terminal:

```sh
python3 -m pr_controller poll
```

Use the dashboard to:

- Refresh PR status manually.
- Read the activity feed.
- Expand full comment bodies.
- Open GitHub links for comments or PRs.
- Send Slack follow-ups to reviewers by email.

Common Slack follow-up examples:

```text
I have addressed the review comments on PR #1234: <title>.
Please review and approve when you get a chance: <url>
```

```text
Could you please review PR #1234: <title>?
Link: <url>
```

## Project Structure

```text
pr-controller/
├── config.yaml
├── requirements.txt
├── launchd/
│   ├── com.prcontroller.poll.plist
│   └── com.prcontroller.serve.plist
├── pr_controller/
│   ├── __main__.py
│   ├── github_client.py
│   ├── notifier.py
│   ├── parser.py
│   ├── poller.py
│   ├── server.py
│   ├── slack.py
│   ├── state.py
│   └── static/
│       ├── app.js
│       ├── index.html
│       └── styles.css
└── scripts/
    └── install.sh
```

## How The Pieces Fit

- `pr_controller/__main__.py` loads config and dispatches `serve` or `poll`.
- `pr_controller/server.py` owns Flask routes, cached PR state, Slack API endpoints, and SSE activity streaming.
- `pr_controller/github_client.py` shells out to `gh api graphql` and fetches PR, review, comment, CI, and public email data.
- `pr_controller/parser.py` converts GraphQL PR nodes into dashboard-ready PR summaries.
- `pr_controller/poller.py` diffs current GitHub state against local state and emits activity events.
- `pr_controller/notifier.py` sends macOS notifications.
- `pr_controller/slack.py` stores the webhook URL and posts Slack Workflow payloads.
- `pr_controller/state.py` stores seen IDs, event history, and reviewer email cache under `~/.pr-controller`.
- `pr_controller/static/*` contains the browser UI.

## Local State Files

Runtime state lives outside the repo:

```text
~/.pr-controller/
├── config.yaml
├── state.json
├── events.json
├── email_cache.json
├── slack.json
├── server.log
└── poll.log
```

Notes:

- `state.json` tracks seen comments/reviews and prevents duplicate notifications.
- `events.json` stores recent activity feed items.
- `email_cache.json` stores public GitHub profile emails discovered during polling.
- `slack.json` stores the Slack Workflow webhook URL and must remain secret.

## API Reference

Primary local endpoints:

- `GET /` serves the dashboard.
- `GET /api/prs` returns current cached PR data.
- `POST /api/refresh` runs a poll immediately and updates the cache.
- `GET /api/events` streams live events through Server-Sent Events.
- `GET /api/events/history` returns recent activity history.
- `GET /api/reviewers` returns cached reviewer email suggestions.
- `GET /api/slack/config` returns Slack configuration status.
- `POST /api/slack/config` saves a Slack webhook URL.
- `DELETE /api/slack/config` removes the saved webhook URL.
- `POST /api/slack/message` sends a Slack Workflow message payload.

## Development Checks

Basic import and route smoke test:

```sh
cd ~/Projects/pr-controller
python3 - <<'PY'
from pr_controller import github_client, notifier, parser, poller, server, slack, state

routes = sorted(str(rule) for rule in server.app.url_map.iter_rules())
for route in routes:
    print(route)

print("imports ok")
PY
```

Manual server smoke test:

```sh
python3 -m pr_controller serve
curl -s http://127.0.0.1:8765/api/prs
```

## Troubleshooting

### `gh` authentication errors

Run:

```sh
gh auth status
gh auth login --hostname github.com --git-protocol https --web
```

### Dashboard loads but has no PRs

Check:

- Whether your PRs are open and authored by the authenticated GitHub user.
- Whether `github.author_filter` in `config.yaml` matches the author you want to watch.
- The server log at `~/.pr-controller/server.log` if using launchd.

### Duplicate or missing notifications

The baseline and dedupe state is stored in:

```text
~/.pr-controller/state.json
```

If you intentionally want to reset all notification history, stop the server and remove that file.

### Slack sends fail

Check:

- The webhook URL is from Slack Workflow Builder.
- The URL starts with `https://hooks.slack.com/triggers/` or `https://hooks.slack.com/workflows/`.
- The Slack workflow defines the variables listed above.
- The workflow is published.

### Notification click does not open the dashboard

Install `terminal-notifier`:

```sh
brew install terminal-notifier
```

Then restart PR Controller.

### launchd service needs a restart

Unload and install again:

```sh
scripts/install.sh --uninstall
scripts/install.sh
```

## Security Notes

- This app is intended for local use only and binds to `127.0.0.1`.
- Do not expose the Flask server to a public network.
- Do not commit files from `~/.pr-controller`.
- Treat Slack Workflow webhook URLs like secrets.
- GitHub access is whatever the local `gh` CLI can access.

