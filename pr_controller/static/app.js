"use strict";

// ── Constants matching pr_controller/parser.py ───────────────────────────────
const CI_ICON = { pass: "✅", fail: "❌", pending: "⏳", none: "⚪" };
const STATE_LABELS = {
  attention: "needs attention",
  pending: "pending checks",
  ready: "ready",
  waiting: "waiting on review",
};
const EVENT_META = {
  new_comment: { icon: "💬", label: "commented", cls: "feed-new-comment" },
  reply: { icon: "↩️", label: "replied", cls: "feed-reply" },
  ci_fail: { icon: "❌", label: "CI failed", cls: "feed-ci-fail" },
  approved: { icon: "✅", label: "approved", cls: "feed-approved" },
  changes_requested: {
    icon: "✋",
    label: "requested changes",
    cls: "feed-changes-requested",
  },
};
const TEMPLATES = {
  review_request: (pr) =>
    `Hi, could you please review PR #${pr.number}?\n\n${pr.title}\n${pr.url}\n\nThank you!`,
  comments_addressed: (pr) =>
    `Hi, I've addressed all the review comments on PR #${pr.number}.\n\n${pr.title}\n${pr.url}\n\nPlease take a look and approve when you get a chance. Thank you!`,
  custom: (pr) => `PR #${pr.number}: ${pr.title}\n${pr.url}`,
};

// ── App state ─────────────────────────────────────────────────────────────────
let unreadCount = 0;
let sseSource = null;
let slackEnabled = false;
let reviewers = []; // [{login, email}] from /api/reviewers
let selectedEmails = new Set();
let composerPR = null; // currently selected PR context

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const urlParams = new URLSearchParams(window.location.search);
  const targetEventId = urlParams.get("event");

  loadPRs();
  loadReviewers();
  loadSlackConfig();
  connectSSE();

  // Load history, then optionally highlight a specific event from URL param
  loadEventHistory().then(() => {
    if (targetEventId) highlightEvent(targetEventId);
  });

  document
    .getElementById("refresh-btn")
    .addEventListener("click", handleRefresh);

  document.getElementById("clear-feed-btn").addEventListener("click", () => {
    document.getElementById("feed-items").innerHTML = "";
    unreadCount = 0;
    renderUnreadBadge();
    showFeedEmpty(true);
  });

  // Settings modal triggers
  document
    .getElementById("settings-btn")
    .addEventListener("click", openSettings);
  document
    .getElementById("settings-close")
    .addEventListener("click", closeSettings);
  document
    .getElementById("settings-cancel")
    .addEventListener("click", closeSettings);
  document
    .getElementById("save-webhook-btn")
    .addEventListener("click", saveWebhook);
  document
    .getElementById("delete-webhook-btn")
    .addEventListener("click", deleteWebhook);

  // Composer modal triggers
  document
    .getElementById("composer-close")
    .addEventListener("click", closeComposer);
  document
    .getElementById("composer-cancel")
    .addEventListener("click", closeComposer);
  document
    .getElementById("composer-send")
    .addEventListener("click", sendSlackMessage);
  document
    .getElementById("composer-template")
    .addEventListener("change", onTemplateChange);

  // Close modals on overlay click
  document.getElementById("settings-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });
  document.getElementById("composer-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeComposer();
  });

  initTagInput();
});

// ── PR data ───────────────────────────────────────────────────────────────────
async function loadPRs() {
  try {
    const res = await fetch("/api/prs");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderSummary(data.summary);
    renderCards(data.prs, Boolean(data.generated_at));
    renderTimestamp(data.generated_at);
  } catch (e) {
    document.getElementById("pr-cards").innerHTML =
      `<div class="error-banner">Failed to load PRs: ${esc(e.message)}</div>`;
  }
}

async function loadEventHistory() {
  try {
    const res = await fetch("/api/events/history?limit=50");
    const events = await res.json();
    const feed = document.getElementById("feed-items");
    feed.innerHTML = "";
    events.forEach((ev) => feed.appendChild(buildFeedItem(ev, false)));
    showFeedEmpty(events.length === 0);
    feed
      .querySelectorAll(".feed-item")
      .forEach((el) => el.classList.add("visible"));
  } catch (e) {
    console.warn("Failed to load event history:", e);
  }
}

async function handleRefresh() {
  const btn = document.getElementById("refresh-btn");
  btn.disabled = true;
  btn.textContent = "⟳ Refreshing…";
  try {
    const res = await fetch("/api/refresh", { method: "POST" });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderSummary(data.summary);
    renderCards(data.prs, Boolean(data.generated_at));
    renderTimestamp(data.generated_at);
    if (data.skipped) {
      showToast("Refresh skipped — another poll is already running.");
      return;
    }
    showToast(
      `Refreshed — ${data.new_events} new event${data.new_events !== 1 ? "s" : ""}`,
    );
  } catch (e) {
    showToast("Refresh failed: " + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "↻ Refresh";
  }
}

// ── Reviewers / email cache ────────────────────────────────────────────────────
async function loadReviewers() {
  try {
    const res = await fetch("/api/reviewers");
    reviewers = await res.json();
  } catch (e) {
    reviewers = [];
  }
}

// ── Slack config ──────────────────────────────────────────────────────────────
async function loadSlackConfig() {
  try {
    const res = await fetch("/api/slack/config");
    const data = await res.json();
    slackEnabled = data.configured;
    updateSettingsBtn();
  } catch (e) {
    slackEnabled = false;
  }
}

function updateSettingsBtn() {
  const btn = document.getElementById("settings-btn");
  if (!btn) return;
  const dot = `<span class="slack-dot${slackEnabled ? " configured" : ""}"></span>`;
  btn.innerHTML = `${dot} Slack`;
}

// ── Settings modal ────────────────────────────────────────────────────────────
async function openSettings() {
  const modal = document.getElementById("settings-modal");
  const input = document.getElementById("webhook-url-input");
  const current = document.getElementById("webhook-current");
  const deleteBtn = document.getElementById("delete-webhook-btn");

  try {
    const res = await fetch("/api/slack/config");
    const data = await res.json();
    if (data.configured) {
      current.textContent = `Current: ${data.preview}`;
      input.placeholder = "Paste new URL to replace…";
      deleteBtn.hidden = false;
    } else {
      current.textContent = "Not configured";
      input.placeholder = "https://hooks.slack.com/triggers/…";
      deleteBtn.hidden = true;
    }
  } catch (_) {}

  input.value = "";
  modal.hidden = false;
  modal.classList.add("open");
  setTimeout(() => input.focus(), 50);
}

function closeSettings() {
  const modal = document.getElementById("settings-modal");
  modal.hidden = true;
  modal.classList.remove("open");
}

async function saveWebhook() {
  const input = document.getElementById("webhook-url-input");
  const url = input.value.trim();
  if (!url) {
    showToast("Paste a webhook URL first.", true);
    return;
  }

  const btn = document.getElementById("save-webhook-btn");
  btn.disabled = true;
  try {
    const res = await fetch("/api/slack/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ webhook_url: url }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    slackEnabled = true;
    updateSettingsBtn();
    closeSettings();
    showToast("Slack webhook saved.");
  } catch (e) {
    showToast("Save failed: " + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function deleteWebhook() {
  if (!confirm("Remove the saved Slack webhook?")) return;
  await fetch("/api/slack/config", { method: "DELETE" });
  slackEnabled = false;
  updateSettingsBtn();
  closeSettings();
  showToast("Slack webhook removed.");
}

// ── Composer modal ────────────────────────────────────────────────────────────
function openComposer(prData, templateKey = "custom", prefillEmail = null) {
  if (!slackEnabled) {
    openSettings();
    return;
  }

  composerPR = prData;
  selectedEmails.clear();
  renderTags();

  // Show PR context chip
  const chip = document.getElementById("composer-pr-context");
  if (prData) {
    chip.hidden = false;
    chip.innerHTML = `PR <a href="${esc(prData.url)}" target="_blank">#${prData.number}</a> — ${esc(prData.title)}`;
    chip.className = "pr-context-chip";
  } else {
    chip.hidden = true;
  }

  // Template
  const tmplSelect = document.getElementById("composer-template");
  tmplSelect.value = templateKey;
  onTemplateChange();

  // Pre-fill recipient
  if (prefillEmail) addTag(prefillEmail);

  // Reset status
  document.getElementById("composer-status").textContent = "";
  document.getElementById("composer-status").className = "composer-status";

  const modal = document.getElementById("composer-modal");
  modal.hidden = false;
  modal.classList.add("open");
  setTimeout(() => document.getElementById("tag-input-field").focus(), 50);
}

function closeComposer() {
  const modal = document.getElementById("composer-modal");
  modal.hidden = true;
  modal.classList.remove("open");
  composerPR = null;
  selectedEmails.clear();
  renderTags();
}

function onTemplateChange() {
  const key = document.getElementById("composer-template").value;
  const area = document.getElementById("composer-message");
  const fn = TEMPLATES[key];
  area.value = fn && composerPR ? fn(composerPR) : "";
}

async function sendSlackMessage() {
  const message = document.getElementById("composer-message").value.trim();
  const statusEl = document.getElementById("composer-status");

  if (!selectedEmails.size) {
    statusEl.textContent = "Add at least one recipient.";
    statusEl.className = "composer-status error";
    return;
  }
  if (!message) {
    statusEl.textContent = "Message cannot be empty.";
    statusEl.className = "composer-status error";
    return;
  }

  const sendBtn = document.getElementById("composer-send");
  sendBtn.disabled = true;
  statusEl.textContent = "Sending…";
  statusEl.className = "composer-status";

  try {
    const res = await fetch("/api/slack/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        emails: [...selectedEmails],
        message,
        pr_number: composerPR ? String(composerPR.number) : "",
        pr_title: composerPR ? composerPR.title : "",
        pr_url: composerPR ? composerPR.url : "",
        event_type: document.getElementById("composer-template").value,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    if (data.errors && data.errors.length) {
      statusEl.textContent = `Sent ${data.sent}, failed: ${data.errors.join("; ")}`;
      statusEl.className = "composer-status error";
    } else {
      const n = data.sent;
      closeComposer();
      showToast(`Sent to ${n} ${n === 1 ? "person" : "people"} via Slack.`);
    }
  } catch (e) {
    statusEl.textContent = "Send failed: " + e.message;
    statusEl.className = "composer-status error";
  } finally {
    sendBtn.disabled = selectedEmails.size === 0;
  }
}

// ── Multi-select tag input ────────────────────────────────────────────────────
function initTagInput() {
  const field = document.getElementById("tag-input-field");
  const wrapper = document.getElementById("tag-input-wrapper");
  if (!field) return;

  field.addEventListener("input", () => showSuggestions(field.value));
  field.addEventListener("focus", () => showSuggestions(field.value));
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const val = field.value.trim().replace(/,+$/, "");
      if (val) {
        addTag(val);
        field.value = "";
        hideSuggestions();
      }
    } else if (e.key === "Backspace" && !field.value) {
      const last = [...selectedEmails].pop();
      if (last) removeTag(last);
    } else if (e.key === "Escape") {
      hideSuggestions();
    }
  });

  wrapper.addEventListener("click", (e) => {
    if (e.target === wrapper || e.target.classList.contains("tag-list")) {
      field.focus();
    }
  });

  document.addEventListener("click", (e) => {
    if (!wrapper.contains(e.target)) hideSuggestions();
  });
}

function showSuggestions(query) {
  const sugEl = document.getElementById("tag-suggestions");
  if (!sugEl) return;
  const q = (query || "").toLowerCase();
  const filtered = reviewers
    .filter((r) => r.email && !selectedEmails.has(r.email))
    .filter(
      (r) =>
        !q ||
        r.login.toLowerCase().includes(q) ||
        r.email.toLowerCase().includes(q),
    )
    .slice(0, 8);

  if (!filtered.length) {
    hideSuggestions();
    return;
  }

  sugEl.innerHTML = filtered
    .map(
      (r) => `
    <div class="tag-suggestion-item" data-email="${esc(r.email)}">
      <span class="sug-login">@${esc(r.login)}</span>
      <span class="sug-email">${esc(r.email)}</span>
    </div>
  `,
    )
    .join("");

  sugEl.querySelectorAll(".tag-suggestion-item").forEach((item) => {
    item.addEventListener("mousedown", (e) => {
      e.preventDefault(); // don't blur the input
      addTag(item.dataset.email);
      document.getElementById("tag-input-field").value = "";
      hideSuggestions();
    });
  });

  sugEl.hidden = false;
}

function hideSuggestions() {
  const sugEl = document.getElementById("tag-suggestions");
  if (sugEl) sugEl.hidden = true;
}

function addTag(email) {
  const normalized = email.trim().toLowerCase();
  if (!normalized || selectedEmails.has(normalized)) return;
  selectedEmails.add(normalized);
  renderTags();
}

// Exposed globally for inline onclick in renderTags
window.removeTag = function (email) {
  selectedEmails.delete(email);
  renderTags();
};

function renderTags() {
  const list = document.getElementById("tag-list");
  if (!list) return;

  list.innerHTML = [...selectedEmails]
    .map(
      (email) => `
    <span class="tag-pill">
      <span>${esc(email)}</span>
      <button class="tag-remove" onclick="removeTag('${esc(email).replace(/'/g, "\\'")}')" aria-label="Remove ${esc(email)}">&times;</button>
    </span>
  `,
    )
    .join("");

  // Update send button
  const sendBtn = document.getElementById("composer-send");
  if (sendBtn) {
    const n = selectedEmails.size;
    sendBtn.disabled = n === 0;
    sendBtn.textContent = n > 1 ? `Send to ${n} people` : "Send";
  }
}

// ── SSE ───────────────────────────────────────────────────────────────────────
function connectSSE() {
  if (sseSource) sseSource.close();
  sseSource = new EventSource("/api/events");
  setConnDot("live");

  sseSource.onmessage = (e) => {
    const event = JSON.parse(e.data);
    if (event.type === "heartbeat") return;
    if (event.type === "connected") {
      setConnDot("live");
      loadPRs();
      return;
    }
    if (event.type === "prs_updated") {
      loadPRs();
      return;
    }
    prependFeedItem(event);
    unreadCount++;
    renderUnreadBadge();
  };

  sseSource.onerror = () => {
    setConnDot("error");
    sseSource.close();
    setTimeout(connectSSE, 5000);
  };
}

function setConnDot(state) {
  const dot = document.getElementById("conn-dot");
  if (!dot) return;
  dot.className = "conn-dot " + state;
}

// ── Activity feed ─────────────────────────────────────────────────────────────
function prependFeedItem(event) {
  const feed = document.getElementById("feed-items");
  const item = buildFeedItem(event, true);
  feed.insertBefore(item, feed.firstChild);
  showFeedEmpty(false);
  requestAnimationFrame(() => item.classList.add("visible"));
}

function buildFeedItem(event, animate) {
  const meta = EVENT_META[event.type] || {
    icon: "📌",
    label: event.type,
    cls: "",
  };
  const timeStr = formatRelativeTime(event.at);
  const prLabel = event.pr_title
    ? `PR #${event.pr_number} — ${event.pr_title.slice(0, 38)}${event.pr_title.length > 38 ? "…" : ""}`
    : `PR #${event.pr_number}`;

  const githubUrl = event.github_url || event.url || "#";
  const hasBody =
    event.body && event.body !== event.snippet && event.body.length > 10;
  const eventId = event.id || "";

  const div = document.createElement("div");
  div.className = `feed-item ${meta.cls}${animate ? "" : " visible"}`;
  if (eventId) div.dataset.eventId = eventId;

  // PR lookup for composer (try to find from cached PR list)
  const prNum = event.pr_number;

  div.innerHTML = `
    <div class="feed-item-header">
      <span class="feed-item-icon">${meta.icon}</span>
      <a class="feed-item-pr" href="${esc(githubUrl)}" target="_blank">${esc(prLabel)}</a>
      <span class="feed-item-time">${timeStr}</span>
    </div>
    <div class="feed-item-meta">${event.author ? "@" + esc(event.author) + " " : ""}${meta.label}</div>
    ${
      event.snippet
        ? `<div class="feed-item-snippet">${esc(event.snippet)}</div>`
        : ""
    }
    ${
      hasBody
        ? `<div class="feed-item-full" hidden>${esc(event.body)}</div>
         <button class="expand-btn" onclick="toggleFeedExpand(this)">Show full comment</button>`
        : ""
    }
    <div class="feed-item-footer">
      <a class="btn-action" href="${esc(githubUrl)}" target="_blank">View on GitHub</a>
      <button class="btn-action btn-action-slack"
        onclick="openComposerForEvent(${prNum}, '${esc(event.author || "")}')"
        title="Message this person in Slack">
        💬 Slack
      </button>
    </div>
  `;
  return div;
}

// Global so inline onclick can call it
window.openComposerForEvent = function (prNum, authorLogin) {
  // Try to find the PR in the cached card list
  const cards = document.querySelectorAll(".card");
  let prData = null;
  for (const card of cards) {
    const numEl = card.querySelector(".card-num");
    if (numEl && numEl.textContent.trim() === `#${prNum}`) {
      const titleEl = card.querySelector(".card-title");
      const linkEl = card.querySelector("a.card-title");
      prData = {
        number: prNum,
        title: titleEl ? titleEl.textContent.trim() : `PR #${prNum}`,
        url: linkEl ? linkEl.href : "#",
      };
      break;
    }
  }

  // Pre-fill email for the author login if we have it
  const reviewer = reviewers.find((r) => r.login === authorLogin);
  openComposer(prData, "comments_addressed", reviewer ? reviewer.email : null);
};

window.toggleFeedExpand = function (btn) {
  const fullEl = btn.previousElementSibling;
  const expanded = !fullEl.hidden;
  fullEl.hidden = expanded;
  btn.textContent = expanded ? "Show full comment" : "Collapse";
};

function highlightEvent(eventId) {
  if (!eventId) return;
  const item = document.querySelector(
    `[data-event-id="${CSS.escape(eventId)}"]`,
  );
  if (!item) {
    showToast("Event not found in current history. It may have been cleared.");
    return;
  }
  item.scrollIntoView({ behavior: "smooth", block: "center" });
  item.classList.add("feed-item-highlight");
  // Auto-expand the full body if available
  const fullEl = item.querySelector(".feed-item-full");
  const expandBtn = item.querySelector(".expand-btn");
  if (fullEl) {
    fullEl.hidden = false;
    if (expandBtn) expandBtn.textContent = "Collapse";
  }
  setTimeout(() => item.classList.remove("feed-item-highlight"), 4000);
}

function showFeedEmpty(show) {
  const empty = document.getElementById("feed-empty");
  if (empty) empty.style.display = show ? "" : "none";
}

function renderUnreadBadge() {
  const badge = document.getElementById("unread-badge");
  if (!badge) return;
  if (unreadCount > 0) {
    badge.textContent = unreadCount;
    badge.style.display = "inline";
  } else {
    badge.style.display = "none";
  }
}

// ── Summary chips ─────────────────────────────────────────────────────────────
function renderSummary(summary) {
  document.getElementById("summary").innerHTML = [
    ["red", "🔴", "needs attention", summary.attention],
    ["orange", "🔶", "pending", summary.pending],
    ["yellow", "🟡", "waiting", summary.waiting],
    ["green", "🟢", "ready", summary.ready],
  ]
    .map(
      ([color, emoji, label, n]) =>
        `<span class="chip chip-${color}">${emoji} ${label}: ${n}</span>`,
    )
    .join("");
}

// ── PR card rendering ─────────────────────────────────────────────────────────
function classify(pr) {
  const blocked = pr.unresolved.length > 0;
  if (pr.ci === "fail" || blocked || pr.changes_requested > 0)
    return "attention";
  if (pr.in_progress.length > 0) return "pending";
  if (pr.ci === "pass" && pr.decision === "APPROVED" && !blocked)
    return "ready";
  return "waiting";
}

function renderCards(prs, cacheReady = true) {
  const container = document.getElementById("pr-cards");
  if (!cacheReady) {
    container.innerHTML = `<div class="loading">Loading PRs…</div>`;
    return;
  }
  if (!prs || prs.length === 0) {
    container.innerHTML = `<div class="empty-state">🎉 No open PRs</div>`;
    return;
  }
  container.innerHTML = prs.map(buildCard).join("");
}

function buildCard(pr) {
  const state = classify(pr);
  const ciClass =
    { pass: "ok", fail: "bad", pending: "run", none: "muted" }[pr.ci] ||
    "muted";

  const pills = [
    `<span class="pill pill-ok">✅ ${pr.approvals} approval${pr.approvals !== 1 ? "s" : ""}</span>`,
    `<span class="pill pill-${ciClass}">${CI_ICON[pr.ci]} CI ${pr.ci}</span>`,
  ];
  if (pr.changes_requested)
    pills.push(
      `<span class="pill pill-bad">✋ ${pr.changes_requested} changes-requested</span>`,
    );
  if (pr.unresolved.length)
    pills.push(
      `<span class="pill pill-bad">🚫 ${pr.unresolved.length} unresolved</span>`,
    );
  if (pr.in_progress.length)
    pills.push(
      `<span class="pill pill-run">🔶 ${pr.in_progress.length} in progress</span>`,
    );
  if (pr.needs_approval && pr.ci !== "fail")
    pills.push(`<span class="pill pill-warn">🔑 needs approval</span>`);
  if (pr.draft) pills.push(`<span class="pill pill-muted">🟦 draft</span>`);

  let blocks = "";
  if (pr.build_fails.length) {
    const items = pr.build_fails
      .map(
        (f) =>
          `<li><a href="${esc(f.url || "#")}" target="_blank">${esc(f.name)}</a></li>`,
      )
      .join("");
    blocks += `<div class="block"><div class="block-title">⚠️ failing checks</div><ul>${items}</ul></div>`;
  }
  if (pr.in_progress.length) {
    const items = pr.in_progress
      .map(
        (f) =>
          `<li><a href="${esc(f.url || "#")}" target="_blank">${esc(f.name)}</a></li>`,
      )
      .join("");
    blocks += `<div class="block block-run"><div class="block-title">🔶 checks in progress</div><ul>${items}</ul></div>`;
  }
  if (pr.unresolved.length) {
    const items = pr.unresolved
      .map((u) => {
        const short = esc(u.snippet || (u.body || "").slice(0, 140));
        // Show full body if it's meaningfully longer than the snippet
        const hasMore = u.body && u.body.length > (u.snippet || "").length + 10;
        return `<li>
        <a href="${esc(u.url)}" target="_blank">@${esc(u.author)}${u.outdated ? " (outdated)" : ""}</a>:
        <span class="comment-snippet">${short}</span>
        ${
          hasMore
            ? `<button class="inline-expand-btn" onclick="toggleInlineComment(this)">…more</button>
          <span class="comment-full hidden">${esc(u.body)}</span>`
            : ""
        }
      </li>`;
      })
      .join("");
    blocks += `<div class="block"><div class="block-title">🚫 unresolved comments</div><ul>${items}</ul></div>`;
  }

  const approversText = pr.approvers.length
    ? pr.approvers.map((a) => "@" + a).join(", ")
    : "none yet";

  // Card actions: one button per reviewer to quickly message them
  const reviewerBtns = [...new Set([...pr.approvers, ...pr.change_requesters])]
    .map((login) => {
      const reviewer = reviewers.find((r) => r.login === login);
      const emailAttr = reviewer ? ` data-email="${esc(reviewer.email)}"` : "";
      return `<button class="btn-action btn-action-slack"
      onclick="openComposerForCard(${pr.number}, '${esc(login)}')"${emailAttr}
      title="Message @${esc(login)} via Slack">
      💬 @${esc(login)}
    </button>`;
    })
    .join("");

  return `
<div class="card card-${state}">
  <div class="card-top">
    <span class="card-num">#${pr.number}</span>
    <span class="card-age">${pr.age}d</span>
    <a class="card-title" href="${esc(pr.url)}" target="_blank" title="${esc(pr.title)}">${esc(pr.title)}</a>
    <span class="state-badge state-${state}">${STATE_LABELS[state]}</span>
  </div>
  <div class="pills">${pills.join("")}</div>
  <div class="card-sub">approved by: ${esc(approversText)}</div>
  ${blocks}
  ${
    reviewerBtns || slackEnabled
      ? `
  <div class="card-actions">
    ${reviewerBtns}
    <button class="btn-action btn-action-slack"
      onclick="openComposerForCard(${pr.number}, null)"
      title="Send a Slack message about this PR">
      💬 Message someone…
    </button>
  </div>`
      : ""
  }
</div>`;
}

// Global for inline onclick in card actions
window.openComposerForCard = function (prNum, authorLogin) {
  const prData = _findPRData(prNum);
  const reviewer = authorLogin
    ? reviewers.find((r) => r.login === authorLogin)
    : null;
  const tmpl = authorLogin ? "review_request" : "custom";
  openComposer(prData, tmpl, reviewer ? reviewer.email : null);
};

window.toggleInlineComment = function (btn) {
  const fullEl = btn.nextElementSibling;
  const visible = !fullEl.classList.contains("hidden");
  fullEl.classList.toggle("hidden");
  btn.textContent = visible ? "…more" : "less";
};

function _findPRData(prNum) {
  const cards = document.querySelectorAll(".card");
  for (const card of cards) {
    const numEl = card.querySelector(".card-num");
    if (numEl && numEl.textContent.trim() === `#${prNum}`) {
      const linkEl = card.querySelector("a.card-title");
      return {
        number: prNum,
        title: linkEl ? linkEl.title : `PR #${prNum}`,
        url: linkEl ? linkEl.href : "#",
      };
    }
  }
  return { number: prNum, title: `PR #${prNum}`, url: "#" };
}

// ── Timestamp ─────────────────────────────────────────────────────────────────
function renderTimestamp(isoStr) {
  const el = document.getElementById("last-updated");
  if (el && isoStr) el.textContent = "Updated " + formatRelativeTime(isoStr);
}

function formatRelativeTime(isoStr) {
  if (!isoStr) return "";
  const diffMs = Date.now() - new Date(isoStr).getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let _toastTimer = null;
function showToast(msg, isError = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " toast-error" : "");
  t.style.display = "block";
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    t.style.display = "none";
  }, 3500);
}

// ── HTML escape ───────────────────────────────────────────────────────────────
function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
