"use strict";

const PANEL_ID = "meerkat-auth-statistics";
const API_ORIGIN = "https://api.github.com";
const CACHE_SHORT_MS = 2 * 60 * 1000;
const CACHE_MEDIUM_MS = 10 * 60 * 1000;
const CACHE_LONG_MS = 6 * 60 * 60 * 1000;
const RECENT_WINDOW_HOURS = 48;
const TRUSTED_AUTHOR_ASSOCIATIONS = new Set(["MEMBER", "OWNER"]);
const RISKY_AUTHOR_ASSOCIATIONS = new Set([
  "NONE",
  "FIRST_TIMER",
  "FIRST_TIME_CONTRIBUTOR",
  "MANNEQUIN"
]);

let activePageKey = "";
let activeRequestId = 0;
let mountTimer = 0;

bootstrap();

function bootstrap() {
  scheduleMount();

  document.addEventListener("turbo:load", scheduleMount);
  document.addEventListener("turbo:render", scheduleMount);
  document.addEventListener("pjax:end", scheduleMount);

  const observer = new MutationObserver(() => {
    if (parsePullContext() && !document.getElementById(PANEL_ID)) {
      scheduleMount();
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

function scheduleMount() {
  window.clearTimeout(mountTimer);
  mountTimer = window.setTimeout(() => {
    mountPanel().catch((error) => {
      renderError(parsePullContext(), error);
    });
  }, 150);
}

async function mountPanel(options = {}) {
  const context = parsePullContext();
  if (!context) {
    removePanel();
    activePageKey = "";
    return;
  }

  const anchor = findReviewersAnchor();
  if (!anchor) {
    return;
  }

  const pageKey = `${context.owner}/${context.repo}#${context.pullNumber}`;
  if (!options.force && activePageKey === pageKey && document.getElementById(PANEL_ID)) {
    return;
  }

  activePageKey = pageKey;
  const requestId = ++activeRequestId;

  const panel = ensurePanel(anchor);
  renderLoading(panel, context);

  const stats = await loadAuthorStats(context, options.force);
  if (requestId !== activeRequestId) {
    return;
  }
  renderStats(panel, context, stats);
}

function parsePullContext() {
  const match = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) {
    return null;
  }
  return {
    owner: decodeURIComponent(match[1]),
    repo: decodeURIComponent(match[2]),
    pullNumber: Number(match[3])
  };
}

function findReviewersAnchor() {
  const sidebar =
    document.querySelector("#partial-discussion-sidebar") ||
    document.querySelector(".Layout-sidebar") ||
    document.querySelector('[data-testid="sidebar"]');

  if (!sidebar) {
    return null;
  }

  const headings = Array.from(
    sidebar.querySelectorAll(".discussion-sidebar-heading, h2, h3, summary, strong, span")
  );
  const reviewersHeading = headings.find((element) => {
    return normalizeText(element.textContent) === "reviewers";
  });

  if (reviewersHeading) {
    return (
      reviewersHeading.closest(".discussion-sidebar-item") ||
      reviewersHeading.closest("section") ||
      reviewersHeading.closest("div") ||
      sidebar
    );
  }

  return sidebar;
}

function ensurePanel(anchor) {
  let panel = document.getElementById(PANEL_ID);
  if (!panel) {
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "mh-panel";
  }

  if (anchor.matches("#partial-discussion-sidebar, .Layout-sidebar, [data-testid='sidebar']")) {
    anchor.append(panel);
  } else if (anchor.nextSibling !== panel) {
    anchor.insertAdjacentElement("afterend", panel);
  }

  return panel;
}

function removePanel() {
  const panel = document.getElementById(PANEL_ID);
  if (panel) {
    panel.remove();
  }
}

async function loadAuthorStats(context, forceRefresh) {
  const pull = await githubGet(
    `/repos/${context.owner}/${context.repo}/pulls/${context.pullNumber}`,
    {},
    forceRefresh ? 0 : CACHE_SHORT_MS
  );

  const login = pull.user && pull.user.login;
  if (!login) {
    throw new Error("Could not read the PR author from the GitHub API response.");
  }

  const userPromise = githubGet(`/users/${login}`, {}, forceRefresh ? 0 : CACHE_LONG_MS);
  const searchPromises = buildSearchRequests(context, login, forceRefresh);
  const [user, searchResults] = await Promise.all([
    userPromise,
    Promise.all(searchPromises.map((request) => runSearchRequest(request)))
  ]);

  const counts = Object.fromEntries(
    searchResults.map((result) => [result.id, result])
  );

  return {
    pull,
    user,
    counts,
    signal: scoreAuthor({ pull, user, counts }),
    fetchedAt: new Date()
  };
}

function buildSearchRequests(context, login, forceRefresh) {
  const ownerRepo = `${context.owner}/${context.repo}`;
  const sinceIso = new Date(Date.now() - RECENT_WINDOW_HOURS * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");

  const requests = [
    {
      id: "repoTotal",
      label: "Repo PRs",
      query: `repo:${ownerRepo} is:pr author:${login}`,
      link: repoPullsLink(context, `is:pr author:${login}`)
    },
    {
      id: "repoMerged",
      label: "Merged in repo",
      query: `repo:${ownerRepo} is:pr author:${login} is:merged`,
      link: repoPullsLink(context, `is:pr author:${login} is:merged`)
    },
    {
      id: "repoOpen",
      label: "Open in repo",
      query: `repo:${ownerRepo} is:pr author:${login} is:open`,
      link: repoPullsLink(context, `is:pr author:${login} is:open`)
    },
    {
      id: "repoClosedUnmerged",
      label: "Closed unmerged",
      query: `repo:${ownerRepo} is:pr author:${login} is:closed -is:merged`,
      link: repoPullsLink(context, `is:pr author:${login} is:closed -is:merged`)
    },
    {
      id: "repoRecent48h",
      label: "Repo PRs in 48h",
      query: `repo:${ownerRepo} is:pr author:${login} created:>=${sinceIso}`,
      link: repoPullsLink(context, `is:pr author:${login} created:>=${sinceIso}`)
    },
    {
      id: "globalRecent48h",
      label: "All PRs in 48h",
      query: `is:pr author:${login} created:>=${sinceIso}`,
      link: githubSearchLink("/pulls", `is:pr author:${login} created:>=${sinceIso}`)
    },
    {
      id: "repoIssues",
      label: "Repo issues",
      query: `repo:${ownerRepo} is:issue author:${login}`,
      link: githubSearchLink(
        `/${context.owner}/${context.repo}/issues`,
        `is:issue author:${login}`
      )
    }
  ];

  return requests.map((request) => ({
    ...request,
    ttlMs: forceRefresh ? 0 : CACHE_MEDIUM_MS
  }));
}

async function runSearchRequest(request) {
  try {
    const data = await githubGet(
      "/search/issues",
      {
        q: request.query,
        per_page: "1"
      },
      request.ttlMs
    );

    return {
      ...request,
      ok: true,
      count: data.total_count || 0,
      incomplete: Boolean(data.incomplete_results)
    };
  } catch (error) {
    return {
      ...request,
      ok: false,
      count: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function githubGet(path, params = {}, cacheTtlMs = CACHE_MEDIUM_MS) {
  const url = new URL(path, API_ORIGIN);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, value);
    }
  });

  const response = await sendRuntimeMessage({
    type: "mh:github-request",
    url: url.toString(),
    cacheKey: url.toString(),
    cacheTtlMs
  });

  if (!response || !response.ok) {
    const detail =
      response && response.data && response.data.message
        ? response.data.message
        : response && response.error
          ? response.error
          : "GitHub API request failed.";
    const status = response && response.status ? ` (${response.status})` : "";
    throw new Error(`${detail}${status}`);
  }

  githubGet.lastRate = response.rate || null;
  return response.data;
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function scoreAuthor({ pull, user, counts }) {
  const signals = [];
  let score = 0;

  const accountAgeDays = daysSince(user.created_at);
  const repoTotal = getCount(counts.repoTotal);
  const repoMerged = getCount(counts.repoMerged);
  const closedUnmerged = getCount(counts.repoClosedUnmerged);
  const recentGlobal = getCount(counts.globalRecent48h);
  const recentRepo = getCount(counts.repoRecent48h);
  const association = pull.author_association || "UNKNOWN";
  const trustedSignals = [];

  if (TRUSTED_AUTHOR_ASSOCIATIONS.has(association)) {
    trustedSignals.push(`Author association is ${association}`);
  }

  if (repoMerged !== null && repoMerged > 20) {
    trustedSignals.push(`Merged ${formatNumber(repoMerged)} PRs in this repo`);
  }

  if (trustedSignals.length) {
    return { level: "Trusted", tone: "trusted", score: 0, signals: trustedSignals };
  }

  if (accountAgeDays !== null && accountAgeDays < 7) {
    score += 4;
    signals.push("Account is under 7 days old");
  } else if (accountAgeDays !== null && accountAgeDays < 30) {
    score += 3;
    signals.push("Account is under 30 days old");
  } else if (accountAgeDays !== null && accountAgeDays < 180) {
    score += 1;
    signals.push("Account is under 6 months old");
  }

  if (RISKY_AUTHOR_ASSOCIATIONS.has(association)) {
    score += 2;
    signals.push(`Author association is ${association}`);
  }

  if (repoTotal !== null && repoTotal <= 1) {
    score += 2;
    signals.push("No earlier PR history in this repo");
  }

  if (repoMerged === 0) {
    score += 1;
    signals.push("No merged PRs in this repo");
  }

  if (closedUnmerged !== null && closedUnmerged >= 3 && repoMerged === 0) {
    score += 2;
    signals.push("Several closed unmerged PRs and no merged PRs here");
  }

  if (recentGlobal !== null && recentGlobal >= 10) {
    score += 4;
    signals.push(`Created ${recentGlobal} PRs across GitHub in 48h`);
  } else if (recentGlobal !== null && recentGlobal >= 5) {
    score += 2;
    signals.push(`Created ${recentGlobal} PRs across GitHub in 48h`);
  } else if (recentGlobal !== null && recentGlobal >= 3) {
    score += 1;
    signals.push(`Created ${recentGlobal} PRs across GitHub in 48h`);
  }

  if (recentRepo !== null && recentRepo >= 3) {
    score += 2;
    signals.push(`Created ${recentRepo} PRs in this repo in 48h`);
  }

  if (user.public_repos === 0 && user.followers === 0) {
    score += 1;
    signals.push("Profile has no public repos or followers");
  }

  if (pull.changed_files >= 50 || pull.additions + pull.deletions >= 10000) {
    score += 1;
    signals.push("Current PR has a large change footprint");
  }

  if (score >= 7) {
    return { level: "Elevated", tone: "high", score, signals };
  }
  if (score >= 3) {
    return { level: "Watch", tone: "medium", score, signals };
  }
  return { level: "Low", tone: "low", score, signals };
}

function renderLoading(panel, context) {
  panel.innerHTML = `
    <div class="mh-card mh-loading">
      <div class="mh-title-row">
        <h3>Author statistics</h3>
        <span class="mh-spinner" aria-hidden="true"></span>
      </div>
      <p>Loading ${escapeHtml(context.owner)}/${escapeHtml(context.repo)} PR data...</p>
    </div>
  `;
}

function renderStats(panel, context, stats) {
  const { pull, user, counts, signal, fetchedAt } = stats;
  const profileUrl = user.html_url || `https://github.com/${user.login}`;
  const mergedRatio = ratioText(getCount(counts.repoMerged), getCount(counts.repoTotal));
  const rate = githubGet.lastRate;

  panel.innerHTML = `
    <div class="mh-card">
      <div class="mh-title-row">
        <h3>Author statistics</h3>
        <div class="mh-actions">
          <button type="button" class="mh-button mh-refresh">Refresh</button>
          <button type="button" class="mh-button mh-options">Token</button>
        </div>
      </div>

      <div class="mh-author-row">
        <a href="${escapeAttribute(profileUrl)}" target="_blank" rel="noreferrer">@${escapeHtml(user.login)}</a>
        <span class="mh-pill mh-pill-${signal.tone}">${escapeHtml(signal.level)}</span>
      </div>

      ${renderSignals(signal)}

      <dl class="mh-stat-list">
        ${renderLinkedStat(counts.repoTotal)}
        ${renderLinkedStat(counts.repoMerged)}
        ${renderLinkedStat(counts.repoOpen)}
        ${renderLinkedStat(counts.repoClosedUnmerged)}
        ${renderLinkedStat(counts.repoRecent48h)}
        ${renderLinkedStat(counts.repoIssues)}
        ${renderPlainStat("Merged ratio here", mergedRatio)}
        ${renderPlainStat("Author association", pull.author_association || "UNKNOWN")}
        ${renderLinkedStat(counts.globalRecent48h)}
        ${renderProfileStat("Account created", formatDate(user.created_at), profileUrl)}
        ${renderProfileStat("Account age", formatDurationDays(daysSince(user.created_at)), profileUrl)}
        ${renderProfileStat("Public repos", formatNumber(user.public_repos), `${profileUrl}?tab=repositories`)}
        ${renderProfileStat("Followers", formatNumber(user.followers), `${profileUrl}?tab=followers`)}
        ${renderPlainStat("Current PR age", formatDurationDays(daysSince(pull.created_at)))}
        ${renderPlainStat("Current PR size", formatPrSize(pull))}
      </dl>

      <div class="mh-footer">
        <span>Updated ${escapeHtml(formatTime(fetchedAt))}</span>
        ${rate && rate.remaining !== null ? `<span>API remaining ${escapeHtml(rate.remaining)}</span>` : ""}
      </div>
    </div>
  `;

  panel.querySelector(".mh-refresh").addEventListener("click", () => {
    mountPanel({ force: true }).catch((error) => renderError(context, error));
  });

  panel.querySelector(".mh-options").addEventListener("click", () => {
    sendRuntimeMessage({ type: "mh:open-options" }).catch(() => {});
  });
}

function renderSignals(signal) {
  if (!signal.signals.length) {
    return `<div class="mh-signal mh-signal-${signal.tone}">No obvious spam signals from these metrics.</div>`;
  }

  const items = signal.signals
    .slice(0, 5)
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");

  return `<ul class="mh-signal-list mh-signal-list-${signal.tone}">${items}</ul>`;
}

function renderLinkedStat(stat) {
  const value = stat.ok
    ? `${stat.incomplete ? "~" : ""}${formatNumber(stat.count)}`
    : "Error";
  const title = stat.ok ? "" : ` title="${escapeAttribute(stat.error || "Request failed")}"`;
  return `
    <div class="mh-stat"${title}>
      <dt>${escapeHtml(stat.label)}</dt>
      <dd><a href="${escapeAttribute(stat.link)}" target="_blank" rel="noreferrer">${escapeHtml(value)}</a></dd>
    </div>
  `;
}

function renderProfileStat(label, value, url) {
  return `
    <div class="mh-stat">
      <dt>${escapeHtml(label)}</dt>
      <dd><a href="${escapeAttribute(url)}" target="_blank" rel="noreferrer">${escapeHtml(value)}</a></dd>
    </div>
  `;
}

function renderPlainStat(label, value) {
  return `
    <div class="mh-stat">
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(value)}</dd>
    </div>
  `;
}

function renderError(context, error) {
  const anchor = findReviewersAnchor();
  if (!context || !anchor) {
    return;
  }
  const panel = ensurePanel(anchor);
  const message = error instanceof Error ? error.message : String(error);
  panel.innerHTML = `
    <div class="mh-card mh-error">
      <div class="mh-title-row">
        <h3>Author statistics</h3>
        <button type="button" class="mh-button mh-options">Token</button>
      </div>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
  panel.querySelector(".mh-options").addEventListener("click", () => {
    sendRuntimeMessage({ type: "mh:open-options" }).catch(() => {});
  });
}

function getCount(result) {
  if (!result || !result.ok || typeof result.count !== "number") {
    return null;
  }
  return result.count;
}

function repoPullsLink(context, query) {
  return githubSearchLink(`/${context.owner}/${context.repo}/pulls`, query);
}

function githubSearchLink(path, query) {
  return `https://github.com${path}?q=${encodeURIComponent(query)}`;
}

function daysSince(dateValue) {
  if (!dateValue) {
    return null;
  }
  const timestamp = new Date(dateValue).getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return Math.max(0, Math.floor((Date.now() - timestamp) / 86400000));
}

function ratioText(part, total) {
  if (part === null || total === null || total === 0) {
    return "N/A";
  }
  return `${Math.round((part / total) * 100)}%`;
}

function formatDurationDays(days) {
  if (days === null) {
    return "N/A";
  }
  if (days < 1) {
    return "<1 day";
  }
  if (days < 60) {
    return `${days} days`;
  }
  if (days < 730) {
    return `${Math.floor(days / 30)} months`;
  }
  return `${Math.floor(days / 365)} years`;
}

function formatPrSize(pull) {
  const additions = formatNumber(pull.additions || 0);
  const deletions = formatNumber(pull.deletions || 0);
  const files = formatNumber(pull.changed_files || 0);
  const commits = formatNumber(pull.commits || 0);
  return `+${additions} -${deletions}, ${files} files, ${commits} commits`;
}

function formatDate(value) {
  if (!value) {
    return "N/A";
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(new Date(value));
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  }).format(value);
}

function formatNumber(value) {
  if (value === null || value === undefined || value === "") {
    return "N/A";
  }
  return new Intl.NumberFormat().format(value);
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
