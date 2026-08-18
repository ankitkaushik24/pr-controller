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
  new_comment: { label: "commented" },
  reply: { label: "replied" },
  ci_fail: { label: "CI failed" },
  approved: { label: "approved" },
  changes_requested: { label: "requested changes" },
};
const TEMPLATES = {
  review_request: (pr) =>
    `Hi, could you please review PR #${pr.number}?\n\n${pr.title}\n${pr.url}\n\nThank you!`,
  comments_addressed: (pr) =>
    `Hi, I've addressed all the review comments on PR #${pr.number}.\n\n${pr.title}\n${pr.url}\n\nPlease take a look and approve when you get a chance. Thank you!`,
  custom: (pr) => `PR #${pr.number}: ${pr.title}\n${pr.url}`,
};
const EMPTY_METADATA_VALUE = "N/A";

// ── App state ─────────────────────────────────────────────────────────────────
let sseSource = null;
let slackEnabled = false;
let reviewers = []; // [{login, email}] from /api/reviewers
let selectedEmails = new Set();
let composerPR = null; // currently selected PR context
let currentPRs = [];
let pendingDeepLink = null; // { pr, comment, focus } from URL

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const urlParams = new URLSearchParams(window.location.search);
  const prParam = urlParams.get("pr");
  const commentParam = urlParams.get("comment");
  const focusParam = urlParams.get("focus");
  if (prParam) {
    pendingDeepLink = {
      pr: prParam,
      comment: commentParam || null,
      focus: focusParam || null,
    };
  }

  loadPRs();
  loadReviewers();
  loadSlackConfig();
  connectSSE();

  document
    .getElementById("refresh-btn")
    .addEventListener("click", handleRefresh);

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
    toastForEvent(event);
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

function toastForEvent(event) {
  const meta = EVENT_META[event.type];
  if (!meta) return;
  const author = event.author ? `@${event.author} ` : "";
  showToast(`PR #${event.pr_number} — ${author}${meta.label}`);
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
    currentPRs = [];
    container.innerHTML = `<div class="loading">Loading PRs…</div>`;
    return;
  }
  if (!prs || prs.length === 0) {
    currentPRs = [];
    container.innerHTML = `<div class="empty-state">🎉 No open PRs</div>`;
    applyPendingDeepLink();
    return;
  }
  currentPRs = prs;
  container.innerHTML = prs.map(buildCard).join("");
  applyPendingDeepLink();
}

function buildCard(pr) {
  const state = classify(pr);
  const ciClass =
    { pass: "ok", fail: "bad", pending: "run", none: "muted" }[pr.ci] ||
    "muted";
  const conversationComments = Array.isArray(pr.conversation_comments)
    ? pr.conversation_comments
    : [];
  const commitComments = Array.isArray(pr.commit_comments)
    ? pr.commit_comments
    : [];
  const reviewBodyComments = Array.isArray(pr.review_body_comments)
    ? pr.review_body_comments
    : [];

  const pills = [
    `<span class="pill pill-ok" data-focus="approved">✅ ${pr.approvals} approval${pr.approvals !== 1 ? "s" : ""}</span>`,
    `<span class="pill pill-${ciClass}" data-focus="ci_fail">${CI_ICON[pr.ci]} CI ${pr.ci}</span>`,
  ];
  if (pr.changes_requested)
    pills.push(
      `<span class="pill pill-bad" data-focus="changes_requested">✋ ${pr.changes_requested} changes-requested</span>`,
    );
  if (pr.unresolved.length)
    pills.push(
      `<span class="pill pill-bad">🚫 ${pr.unresolved.length} unresolved</span>`,
    );
  if (conversationComments.length)
    pills.push(
      `<span class="pill pill-muted">💬 ${conversationComments.length} conversation</span>`,
    );
  if (commitComments.length)
    pills.push(
      `<span class="pill pill-muted">📝 ${commitComments.length} commit</span>`,
    );
  if (reviewBodyComments.length)
    pills.push(
      `<span class="pill pill-muted">🗣 ${reviewBodyComments.length} review</span>`,
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
    blocks += `<div class="block" data-focus="ci_fail"><div class="block-title">⚠️ failing checks</div><ul>${items}</ul></div>`;
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
      .map((comment, commentIndex) => {
        const location = formatCommentLocation(comment);
        const canAct = Boolean(comment.thread_id);
        const replies = Array.isArray(comment.replies) ? comment.replies : [];
        const replyChain =
          replies.length > 0
            ? `<ul class="comment-replies" aria-label="Reply chain">
                ${replies
                  .map(
                    (
                      reply,
                    ) => `<li class="comment-reply" data-comment-id="${esc(reply.comment_id || "")}">
                  <div class="comment-reply-header">
                    <a href="${esc(reply.url || comment.url || "#")}" target="_blank">@${esc(reply.author || "unknown")}</a>
                  </div>
                  ${renderCommentBody(reply)}
                </li>`,
                  )
                  .join("")}
              </ul>`
            : "";
        return `<li class="comment-item" data-thread-id="${esc(comment.thread_id || "")}" data-comment-id="${esc(comment.comment_id || "")}">
        <div class="comment-header">
          <div class="comment-select">
            <input
              type="checkbox"
              class="thread-check"
              ${canAct ? "" : "disabled"}
              onchange="onThreadSelectionChange(${pr.number})"
              aria-label="Select comment by @${esc(comment.author)} to resolve"
            >
            <span>
              <a href="${esc(comment.url)}" target="_blank">@${esc(comment.author)}${comment.outdated ? " (outdated)" : ""}</a>
              ${location ? `<span class="comment-location">${esc(location)}</span>` : ""}
              ${
                replies.length
                  ? `<span class="comment-reply-count">${replies.length} repl${replies.length === 1 ? "y" : "ies"}</span>`
                  : ""
              }
            </span>
          </div>
          <span class="comment-actions">
            <button class="copy-icon-btn" onclick="toggleReplyForm(${pr.number}, ${commentIndex})" title="Reply to this comment" aria-label="Reply to this comment" ${canAct ? "" : "disabled"}>↩</button>
            <button class="copy-icon-btn" onclick="resolveOneThread(${pr.number}, ${commentIndex})" title="Resolve this comment" aria-label="Resolve this comment" ${canAct ? "" : "disabled"}>✓</button>
            <button class="copy-icon-btn" onclick="copyReviewComment(${pr.number}, ${commentIndex})" title="Copy this review comment" aria-label="Copy this review comment">📋</button>
          </span>
        </div>
        ${renderCommentBody(comment)}
        ${replyChain}
        <div class="reply-form hidden" id="reply-form-${pr.number}-${commentIndex}">
          <textarea
            class="reply-textarea"
            rows="3"
            placeholder="Write a reply…"
            aria-label="Reply to @${esc(comment.author)}"
          ></textarea>
          <div class="reply-form-actions">
            <button class="btn btn-secondary btn-sm" onclick="toggleReplyForm(${pr.number}, ${commentIndex})">Cancel</button>
            <button class="btn btn-primary btn-sm" onclick="submitReply(${pr.number}, ${commentIndex})">Reply</button>
          </div>
        </div>
      </li>`;
      })
      .join("");
    blocks += `<div class="block" data-pr-unresolved="${pr.number}">
      <div class="block-title-row">
        <div class="block-title">🚫 unresolved comments</div>
        <div class="block-title-actions">
          <button class="btn-action btn-action-resolve" id="resolve-selected-${pr.number}" onclick="resolveSelectedThreads(${pr.number})" disabled title="Resolve selected comments">
            ✓ Resolve selected
          </button>
          <button class="btn-action btn-action-resolve" onclick="resolveAllThreads(${pr.number})" title="Resolve all comments on this PR">
            ✓ Resolve all
          </button>
        </div>
      </div>
      <ul>${items}</ul>
    </div>`;
  }

  blocks += renderConversationCommentBlock(pr.number, conversationComments);
  blocks += renderReadonlyCommentBlock(
    "📝 commit comments",
    commitComments,
    (comment) => {
      const parts = [];
      if (comment.commit_oid) parts.push(comment.commit_oid);
      const location = formatCommentLocation(comment);
      if (location) parts.push(location);
      return parts.join(" · ");
    },
  );
  blocks += renderReadonlyCommentBlock(
    "🗣 review comments",
    reviewBodyComments,
    (comment) =>
      comment.state ? comment.state.toLowerCase().replace(/_/g, " ") : "",
  );

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
  const copyCommentsBtn = pr.unresolved.length
    ? `<button class="btn-action btn-action-copy"
      onclick="copyPRReviewComments(${pr.number})"
      title="Copy all review comments">
      📋 Copy all
    </button>`
    : "";
  const messageSomeoneBtn =
    reviewerBtns || slackEnabled
      ? `<button class="btn-action btn-action-slack"
      onclick="openComposerForCard(${pr.number}, null)"
      title="Send a Slack message about this PR">
      💬 Message someone…
    </button>`
      : "";
  const cardActions = [copyCommentsBtn, reviewerBtns, messageSomeoneBtn]
    .filter(Boolean)
    .join("");
  const branchRow = pr.branch
    ? `<div class="card-sub card-branch">
      <span class="branch-label">branch:</span>
      <code class="branch-name" title="${esc(pr.branch)}">${esc(pr.branch)}</code>
      <button
        class="copy-icon-btn"
        onclick="copyPRBranch(${pr.number})"
        title="Copy branch name"
        aria-label="Copy branch name"
      >📋</button>
    </div>`
    : "";

  return `
<div class="card card-${state}" data-pr-number="${pr.number}">
  <div class="card-top">
    <span class="card-num">#${pr.number}</span>
    <span class="card-age">${pr.age}d</span>
    <a class="card-title" href="${esc(pr.url)}" target="_blank" title="${esc(pr.title)}">${esc(pr.title)}</a>
    <span class="state-badge state-${state}">${STATE_LABELS[state]}</span>
  </div>
  <div class="pills">${pills.join("")}</div>
  ${branchRow}
  <div class="card-sub" data-focus="approved">approved by: ${esc(approversText)}</div>
  ${blocks}
  ${
    cardActions
      ? `
  <div class="card-actions">
    ${cardActions}
  </div>`
      : ""
  }
</div>`;
}

function renderConversationCommentBlock(prNumber, comments) {
  if (!comments.length) return "";
  const items = comments
    .map((comment, commentIndex) => {
      const location = formatCommentLocation(comment);
      const canDismiss = Boolean(comment.comment_id);
      return `<li class="comment-item" data-comment-id="${esc(comment.comment_id || "")}">
        <div class="comment-header">
          <div class="comment-select">
            <span>
              <a href="${esc(comment.url || "#")}" target="_blank">@${esc(comment.author || "unknown")}</a>
              ${location ? `<span class="comment-location">${esc(location)}</span>` : ""}
            </span>
          </div>
          <span class="comment-actions">
            <a class="copy-icon-btn" href="${esc(comment.url || "#")}" target="_blank" title="View on GitHub" aria-label="View on GitHub">↗</a>
            <button
              class="copy-icon-btn"
              onclick="dismissOneConversationComment(${prNumber}, ${commentIndex})"
              title="Dismiss this conversation comment"
              aria-label="Dismiss this conversation comment"
              ${canDismiss ? "" : "disabled"}
            >✕</button>
          </span>
        </div>
        ${renderCommentBody(comment)}
      </li>`;
    })
    .join("");
  return `<div class="block" data-pr-conversation="${prNumber}">
    <div class="block-title-row">
      <div class="block-title">💬 conversation comments</div>
      <div class="block-title-actions">
        <button
          class="btn-action btn-action-dismiss"
          onclick="dismissAllConversationComments(${prNumber})"
          title="Dismiss all conversation comments on this PR"
        >
          ✕ Dismiss all
        </button>
      </div>
    </div>
    <ul>${items}</ul>
  </div>`;
}

function renderReadonlyCommentBlock(title, comments, locationFn) {
  if (!comments.length) return "";
  const items = comments
    .map((comment) => {
      const location = locationFn ? locationFn(comment) : "";
      return `<li class="comment-item" data-comment-id="${esc(comment.comment_id || "")}">
        <div class="comment-header">
          <div class="comment-select">
            <span>
              <a href="${esc(comment.url || "#")}" target="_blank">@${esc(comment.author || "unknown")}</a>
              ${location ? `<span class="comment-location">${esc(location)}</span>` : ""}
            </span>
          </div>
          <span class="comment-actions">
            <a class="copy-icon-btn" href="${esc(comment.url || "#")}" target="_blank" title="View on GitHub" aria-label="View on GitHub">↗</a>
          </span>
        </div>
        ${renderCommentBody(comment)}
      </li>`;
    })
    .join("");
  return `<div class="block">
    <div class="block-title">${title}</div>
    <ul>${items}</ul>
  </div>`;
}

function applyPendingDeepLink() {
  if (!pendingDeepLink) return;
  const { pr, comment, focus } = pendingDeepLink;
  const card = document.querySelector(
    `.card[data-pr-number="${CSS.escape(String(pr))}"]`,
  );
  if (!card) {
    showToast(`PR #${pr} not found on the dashboard.`, true);
    pendingDeepLink = null;
    return;
  }

  let target = card;
  if (comment) {
    const commentEl = card.querySelector(
      `[data-comment-id="${CSS.escape(comment)}"]`,
    );
    if (commentEl) {
      target = commentEl;
      const fullEl = commentEl.querySelector(".comment-full");
      const expandBtn = commentEl.querySelector(".inline-expand-btn");
      if (fullEl && fullEl.classList.contains("hidden")) {
        fullEl.classList.remove("hidden");
        if (expandBtn) expandBtn.textContent = "less";
      }
    } else {
      showToast("Comment not found on this PR — it may have been resolved.");
    }
  } else if (focus) {
    const focusEl =
      card.querySelector(`.block[data-focus="${CSS.escape(focus)}"]`) ||
      card.querySelector(`[data-focus="${CSS.escape(focus)}"]`);
    if (focusEl) target = focusEl;
  }

  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("deep-link-highlight");
  setTimeout(() => target.classList.remove("deep-link-highlight"), 4000);
  pendingDeepLink = null;
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

window.onThreadSelectionChange = function (prNum) {
  const selected = _selectedThreadIds(prNum);
  const btn = document.getElementById(`resolve-selected-${prNum}`);
  if (!btn) return;
  btn.disabled = selected.length === 0;
  btn.textContent =
    selected.length > 0
      ? `✓ Resolve selected (${selected.length})`
      : "✓ Resolve selected";
};

window.toggleReplyForm = function (prNum, commentIndex) {
  const form = document.getElementById(`reply-form-${prNum}-${commentIndex}`);
  if (!form) return;
  const opening = form.classList.contains("hidden");
  document.querySelectorAll(".reply-form").forEach((el) => {
    el.classList.add("hidden");
  });
  if (opening) {
    form.classList.remove("hidden");
    const textarea = form.querySelector(".reply-textarea");
    if (textarea) {
      textarea.focus();
    }
  }
};

window.submitReply = async function (prNum, commentIndex) {
  const prData = _findCachedPR(prNum);
  const comment = prData ? prData.unresolved[commentIndex] : null;
  const form = document.getElementById(`reply-form-${prNum}-${commentIndex}`);
  const textarea = form ? form.querySelector(".reply-textarea") : null;
  const body = textarea ? textarea.value.trim() : "";
  if (!prData || !comment || !comment.thread_id) {
    showToast("Review comment not found.", true);
    return;
  }
  if (!body) {
    showToast("Reply cannot be empty.", true);
    return;
  }
  const sendBtn = form.querySelector(".btn-primary");
  if (sendBtn) sendBtn.disabled = true;
  try {
    const res = await fetch("/api/threads/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_id: comment.thread_id, body }),
    });
    const data = await res.json();
    if (!res.ok || data.error)
      throw new Error(data.error || `HTTP ${res.status}`);
    if (textarea) textarea.value = "";
    form.classList.add("hidden");
    if (Array.isArray(data.prs)) {
      const summary = data.summary || {
        attention: 0,
        pending: 0,
        ready: 0,
        waiting: 0,
      };
      if (!data.summary) {
        data.prs.forEach((pr) => {
          summary[classify(pr)] += 1;
        });
      }
      renderSummary(summary);
      renderCards(data.prs, Boolean(data.generated_at));
      renderTimestamp(data.generated_at);
    } else if (data.comment) {
      const replies = comment.replies || (comment.replies = []);
      const replyId = data.comment.id || "";
      if (!replyId || !replies.some((reply) => reply.comment_id === replyId)) {
        replies.push({
          comment_id: replyId,
          author: data.comment.author || "",
          body: data.comment.body || body,
          snippet:
            data.comment.snippet ||
            (data.comment.body || body).replace(/\s+/g, " ").slice(0, 140),
          url: data.comment.url || "",
          created_at: "",
        });
      }
      renderCards(currentPRs, true);
    }
    showToast("Reply posted.");
  } catch (e) {
    showToast("Reply failed: " + e.message, true);
  } finally {
    if (sendBtn) sendBtn.disabled = false;
  }
};

window.resolveOneThread = function (prNum, commentIndex) {
  const prData = _findCachedPR(prNum);
  const comment = prData ? prData.unresolved[commentIndex] : null;
  if (!comment || !comment.thread_id) {
    showToast("Review comment not found.", true);
    return;
  }
  resolveThreads(prNum, [comment.thread_id]);
};

window.resolveSelectedThreads = function (prNum) {
  const threadIds = _selectedThreadIds(prNum);
  if (!threadIds.length) {
    showToast("Select at least one comment to resolve.", true);
    return;
  }
  resolveThreads(prNum, threadIds);
};

window.resolveAllThreads = function (prNum) {
  const prData = _findCachedPR(prNum);
  if (!prData || !prData.unresolved.length) {
    showToast("No review comments to resolve.", true);
    return;
  }
  const threadIds = prData.unresolved
    .map((comment) => comment.thread_id)
    .filter(Boolean);
  if (!threadIds.length) {
    showToast("Missing thread IDs for these comments.", true);
    return;
  }
  resolveThreads(prNum, threadIds);
};

async function resolveThreads(prNum, threadIds) {
  const uniqueIds = [...new Set(threadIds.filter(Boolean))];
  if (!uniqueIds.length) {
    showToast("No threads to resolve.", true);
    return;
  }
  try {
    const res = await fetch("/api/threads/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_ids: uniqueIds }),
    });
    const data = await res.json();
    if (!res.ok || data.error)
      throw new Error(data.error || `HTTP ${res.status}`);
    if (data.prs) {
      renderSummary(data.summary);
      renderCards(data.prs, Boolean(data.generated_at));
      renderTimestamp(data.generated_at);
    }
    const resolvedCount = (data.resolved || []).length;
    const errorCount = (data.errors || []).length;
    if (resolvedCount && !errorCount) {
      showToast(
        `Resolved ${resolvedCount} comment${resolvedCount === 1 ? "" : "s"}.`,
      );
    } else if (resolvedCount && errorCount) {
      showToast(`Resolved ${resolvedCount}, failed ${errorCount}.`, true);
    } else {
      const firstError =
        (data.errors && data.errors[0] && data.errors[0].error) ||
        "Resolve failed.";
      showToast(firstError, true);
    }
  } catch (e) {
    showToast("Resolve failed: " + e.message, true);
  }
}

window.dismissOneConversationComment = function (prNum, commentIndex) {
  const prData = _findCachedPR(prNum);
  const comment = prData
    ? (prData.conversation_comments || [])[commentIndex]
    : null;
  if (!comment || !comment.comment_id) {
    showToast("Conversation comment not found.", true);
    return;
  }
  dismissConversationComments(prNum, [comment.comment_id]);
};

window.dismissAllConversationComments = function (prNum) {
  const prData = _findCachedPR(prNum);
  const comments = prData ? prData.conversation_comments || [] : [];
  if (!comments.length) {
    showToast("No conversation comments to dismiss.", true);
    return;
  }
  const commentIds = comments.map((comment) => comment.comment_id).filter(Boolean);
  if (!commentIds.length) {
    showToast("Missing comment IDs for these conversation comments.", true);
    return;
  }
  dismissConversationComments(prNum, commentIds);
};

async function dismissConversationComments(prNum, commentIds) {
  const uniqueIds = [...new Set(commentIds.filter(Boolean))];
  if (!uniqueIds.length) {
    showToast("No conversation comments to dismiss.", true);
    return;
  }
  try {
    const res = await fetch("/api/comments/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment_ids: uniqueIds }),
    });
    const data = await res.json();
    if (!res.ok || data.error)
      throw new Error(data.error || `HTTP ${res.status}`);
    if (data.prs) {
      renderSummary(data.summary);
      renderCards(data.prs, Boolean(data.generated_at));
      renderTimestamp(data.generated_at);
    }
    const dismissedCount = (data.dismissed || uniqueIds).length;
    showToast(
      `Dismissed ${dismissedCount} conversation comment${dismissedCount === 1 ? "" : "s"}.`,
    );
  } catch (e) {
    showToast("Dismiss failed: " + e.message, true);
  }
}

function _selectedThreadIds(prNum) {
  const block = document.querySelector(`[data-pr-unresolved="${prNum}"]`);
  if (!block) return [];
  return [...block.querySelectorAll(".comment-item")]
    .filter((item) => {
      const checkbox = item.querySelector(".thread-check");
      return checkbox && checkbox.checked && !checkbox.disabled;
    })
    .map((item) => item.dataset.threadId)
    .filter(Boolean);
}

window.copyPRBranch = function (prNum) {
  const prData = _findCachedPR(prNum);
  const branch = prData && prData.branch ? String(prData.branch).trim() : "";
  if (!branch) {
    showToast("Branch name not available.", true);
    return;
  }
  copyTextToClipboard(branch, `Copied branch: ${branch}`);
};

window.copyPRReviewComments = function (prNum) {
  const prData = _findCachedPR(prNum);
  if (!prData || !prData.unresolved.length) {
    showToast("No review comments to copy.", true);
    return;
  }
  const text = formatPRReviewComments(prData);
  const count = prData.unresolved.length;
  copyTextToClipboard(
    text,
    `Copied ${count} review comment${count === 1 ? "" : "s"}.`,
  );
};

window.copyReviewComment = function (prNum, commentIndex) {
  const prData = _findCachedPR(prNum);
  const comment = prData ? prData.unresolved[commentIndex] : null;
  if (!prData || !comment) {
    showToast("Review comment not found.", true);
    return;
  }
  copyTextToClipboard(
    formatSingleReviewComment(prData, comment, commentIndex),
    "Copied review comment.",
  );
};

function formatPRReviewComments(prData) {
  return [
    formatPRHeader(prData),
    "",
    ...prData.unresolved.map((comment, commentIndex) =>
      formatReviewComment(comment, commentIndex),
    ),
  ].join("\n");
}

function formatSingleReviewComment(prData, comment, commentIndex) {
  return [
    formatPRHeader(prData),
    "",
    formatReviewComment(comment, commentIndex),
  ].join("\n");
}

function formatPRHeader(prData) {
  const lines = [
    `PR #${prData.number}: ${prData.title}`,
    `url: ${prData.url}`,
  ];
  if (prData.branch) lines.push(`branch: ${prData.branch}`);
  return lines.join("\n");
}

function formatReviewComment(comment, commentIndex) {
  const body = (comment.body || comment.snippet || "").trim();
  const lines = [
    `Review comment ${commentIndex + 1}`,
    `threadId: ${comment.thread_id || EMPTY_METADATA_VALUE}`,
    `commentId: ${comment.comment_id || EMPTY_METADATA_VALUE}`,
    `path: ${comment.path || EMPTY_METADATA_VALUE}`,
    `line: ${comment.line ?? EMPTY_METADATA_VALUE}`,
    `author: @${comment.author || "unknown"}`,
    `url: ${comment.url || EMPTY_METADATA_VALUE}`,
    `outdated: ${Boolean(comment.outdated)}`,
    "",
    "body:",
    body || EMPTY_METADATA_VALUE,
    "",
  ];
  const replies = Array.isArray(comment.replies) ? comment.replies : [];
  replies.forEach((reply, replyIndex) => {
    const replyBody = (reply.body || reply.snippet || "").trim();
    lines.push(
      `reply ${replyIndex + 1}`,
      `commentId: ${reply.comment_id || EMPTY_METADATA_VALUE}`,
      `author: @${reply.author || "unknown"}`,
      `url: ${reply.url || EMPTY_METADATA_VALUE}`,
      "",
      "body:",
      replyBody || EMPTY_METADATA_VALUE,
      "",
    );
  });
  return lines.join("\n");
}

function renderCommentBody(comment) {
  const short = esc(comment.snippet || (comment.body || "").slice(0, 140));
  const hasMore =
    comment.body && comment.body.length > (comment.snippet || "").length + 10;
  return `<span class="comment-snippet">${short}</span>${
    hasMore
      ? `<button class="inline-expand-btn" onclick="toggleInlineComment(this)">…more</button>
        <span class="comment-full hidden">${esc(comment.body)}</span>`
      : ""
  }`;
}

function formatCommentLocation(comment) {
  if (!comment.path && comment.line == null) return "";
  const path = comment.path || "Unknown path";
  return comment.line == null ? path : `${path}:${comment.line}`;
}

async function copyTextToClipboard(text, successMessage) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      fallbackCopyText(text);
    }
    showToast(successMessage);
  } catch (error) {
    console.warn("Failed to copy review comments:", error);
    showToast("Copy failed. Please try again.", true);
  }
}

function fallbackCopyText(text) {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.select();
  const copied = document.execCommand("copy");
  textArea.remove();
  if (!copied) throw new Error("Clipboard command failed");
}

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

function _findCachedPR(prNum) {
  return currentPRs.find((prData) => String(prData.number) === String(prNum));
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
