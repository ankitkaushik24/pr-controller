"""Compute and classify PR status. Ported from pr-parse.py."""
from __future__ import annotations

from datetime import datetime, timezone

BAD_RUN = {"FAILURE", "CANCELLED", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"}
BAD_CTX = {"FAILURE", "ERROR"}
APPROVER = "Validate Required Approvers"

CI_ICON: dict[str, str] = {"pass": "✅", "fail": "❌", "pending": "⏳", "none": "⚪"}
DECISION_SHORT: dict[str | None, str] = {
    "APPROVED": "approved",
    "CHANGES_REQUESTED": "changes-requested",
    "REVIEW_REQUIRED": "review-required",
    None: "no-reviewers",
}
STATE_LABEL: dict[str, str] = {
    "attention": "needs attention",
    "pending": "pending checks",
    "ready": "ready",
    "waiting": "waiting on review",
}


def compute(nodes: list) -> list[dict]:
    """Transform raw GraphQL nodes into a sorted list of PR summary dicts."""
    now = datetime.now(timezone.utc)
    out: list[dict] = []

    for pr in nodes:
        if not pr:
            continue
        created = datetime.fromisoformat(pr["createdAt"].replace("Z", "+00:00"))
        age = (now - created).days

        approvers, change_requesters = [], []
        for r in pr["latestOpinionatedReviews"]["nodes"]:
            who = (r.get("author") or {}).get("login") or "unknown"
            if r["state"] == "APPROVED":
                approvers.append(who)
            elif r["state"] == "CHANGES_REQUESTED":
                change_requesters.append(who)

        unresolved = []
        for t in pr["reviewThreads"]["nodes"]:
            if t["isResolved"]:
                continue
            c = t["comments"]["nodes"][0] if t["comments"]["nodes"] else None
            full_body = ((c or {}).get("bodyText") or "")
            unresolved.append({
                "author": ((c or {}).get("author") or {}).get("login") or "unknown",
                "body": full_body,
                "snippet": " ".join(full_body.split())[:140],
                "url": (c or {}).get("url") or pr["url"],
                "outdated": t.get("isOutdated", False),
            })

        commits = pr["commits"]["nodes"]
        roll = commits[0]["commit"]["statusCheckRollup"] if commits else None
        fails, in_progress, seen_names, ip_seen, rollup_state = [], [], set(), set(), None

        if roll:
            rollup_state = roll["state"]
            for ctx in roll["contexts"]["nodes"]:
                if ctx["__typename"] == "CheckRun":
                    name, url = ctx.get("name"), ctx.get("detailsUrl")
                    bad = ctx.get("conclusion") in BAD_RUN
                    running = ctx.get("status") != "COMPLETED"
                elif ctx["__typename"] == "StatusContext":
                    name, url = ctx.get("context"), ctx.get("targetUrl")
                    bad = ctx.get("state") in BAD_CTX
                    running = ctx.get("state") in ("PENDING", "EXPECTED")
                else:
                    continue
                if bad and name and name not in seen_names:
                    seen_names.add(name)
                    fails.append({"name": name, "url": url})
                elif running and not bad and name and name not in ip_seen:
                    ip_seen.add(name)
                    in_progress.append({"name": name, "url": url})

        build_fails = [f for f in fails if APPROVER not in f["name"]]
        needs_approval = any(APPROVER in f["name"] for f in fails)
        ci = (
            "fail" if build_fails else
            "none" if roll is None else
            "pending" if (in_progress or rollup_state == "PENDING") else
            "pass"
        )

        out.append({
            "number": pr["number"],
            "title": pr["title"],
            "draft": pr["isDraft"],
            "url": pr["url"],
            "age": age,
            "approvals": len(approvers),
            "approvers": approvers,
            "changes_requested": len(change_requesters),
            "change_requesters": change_requesters,
            "decision": pr["reviewDecision"],
            "unresolved": unresolved,
            "ci": ci,
            "build_fails": build_fails,
            "in_progress": in_progress,
            "needs_approval": needs_approval,
        })

    out.sort(key=lambda x: -x["age"])
    return out


def classify(p: dict) -> str:
    """Return the overall state bucket for one PR."""
    blocked = len(p["unresolved"]) > 0
    if p["ci"] == "fail" or blocked or p["changes_requested"] > 0:
        return "attention"
    if p["in_progress"]:
        return "pending"
    if p["ci"] == "pass" and p["decision"] == "APPROVED" and not blocked:
        return "ready"
    return "waiting"


def buckets(prs: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {"attention": 0, "pending": 0, "ready": 0, "waiting": 0}
    for p in prs:
        counts[classify(p)] += 1
    return counts
