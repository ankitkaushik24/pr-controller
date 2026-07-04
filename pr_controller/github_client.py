"""GitHub GraphQL client using the `gh` CLI."""
from __future__ import annotations

import json
import subprocess

# Expanded query: full comment lists per thread, top-level review submissions,
# reviewer emails (public profile only), and mergeable state.
_QUERY = """
query($q: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    nodes {
      ... on PullRequest {
        number
        title
        isDraft
        createdAt
        updatedAt
        url
        reviewDecision
        mergeable
        latestOpinionatedReviews(first: 50) {
          nodes {
            state
            author { login ... on User { email } }
          }
        }
        reviews(first: 50) {
          nodes {
            id
            author { login ... on User { email } }
            state
            body
            submittedAt
            url
          }
        }
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            isOutdated
            comments(first: 50) {
              nodes {
                id
                author { login ... on User { email } }
                bodyText
                createdAt
                url
              }
            }
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      status
                      conclusion
                      detailsUrl
                    }
                    ... on StatusContext {
                      context
                      state
                      targetUrl
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
"""


def fetch_prs(author_filter: str = "@me") -> dict:
    """Fetch open PRs authored by the configured GitHub user."""
    search_q = f"is:pr is:open author:{author_filter}".strip()
    result = subprocess.run(
        ["gh", "api", "graphql", "-f", f"query={_QUERY}", "-F", f"q={search_q}"],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


def get_my_login() -> str:
    """Return the authenticated GitHub username."""
    result = subprocess.run(
        ["gh", "api", "user", "--jq", ".login"],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def fetch_user_email(login: str) -> str:
    """Fetch a user's public profile email via REST API. Returns '' if private."""
    try:
        result = subprocess.run(
            ["gh", "api", f"/users/{login}", "--jq", ".email // empty"],
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
        return result.stdout.strip()
    except Exception:
        return ""


def extract_emails_from_nodes(nodes: list) -> dict[str, str]:
    """Extract {login: email} pairs already embedded in GraphQL response nodes.
    These are public profile emails — may be empty for private accounts.
    """
    found: dict[str, str] = {}
    for pr in nodes:
        if not pr:
            continue
        for review in (pr.get("reviews") or {}).get("nodes", []):
            _collect_author(review.get("author"), found)
        for review in (pr.get("latestOpinionatedReviews") or {}).get("nodes", []):
            _collect_author(review.get("author"), found)
        for thread in (pr.get("reviewThreads") or {}).get("nodes", []):
            for comment in (thread.get("comments") or {}).get("nodes", []):
                _collect_author(comment.get("author"), found)
    return found


def _collect_author(author: dict | None, target: dict[str, str]) -> None:
    if not author:
        return
    login = author.get("login") or ""
    email = author.get("email") or ""
    if login and email and login not in target:
        target[login] = email


def enrich_email_cache(
    logins_without_email: list[str],
    existing_cache: dict[str, str],
) -> dict[str, str]:
    """REST-fetch emails for logins not yet in cache. Caps at 15 lookups per cycle."""
    updates: dict[str, str] = {}
    for login in logins_without_email[:15]:
        if login in existing_cache:
            continue
        email = fetch_user_email(login)
        if email:
            updates[login] = email
    return updates
