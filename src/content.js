"use strict";

const PANEL_ID = "meerkat-auth-statistics";
const API_ORIGIN = "https://api.github.com";
const AUTHOR_REPO_CACHE_PREFIX = "mh:author-repo:";
const AUTHOR_REPO_CACHE_TTL_STORAGE_KEY = "authorRepoCacheTtlHours";
const CACHE_SHORT_MS = 2 * 60 * 1000;
const CACHE_MEDIUM_MS = 10 * 60 * 1000;
const CACHE_LONG_MS = 6 * 60 * 60 * 1000;
const DEFAULT_AUTHOR_REPO_CACHE_TTL_HOURS = 2;
const MAX_AUTHOR_REPO_CACHE_TTL_HOURS = 24;
const MS_PER_HOUR = 60 * 60 * 1000;
const RECENT_WINDOW_HOURS = 48;
const STAT_VISIBILITY_STORAGE_KEY = "visibleStats";
const TRUSTED_AUTHOR_ASSOCIATIONS = new Set(["MEMBER", "OWNER"]);
const RISKY_AUTHOR_ASSOCIATIONS = new Set([
  "NONE",
  "FIRST_TIMER",
  "FIRST_TIME_CONTRIBUTOR",
  "MANNEQUIN"
]);
const DEFAULT_VISIBLE_STATS = Object.freeze({
  signals: true,
  repoTotal: true,
  repoMerged: true,
  repoOpen: true,
  repoClosedUnmerged: true,
  repoRecent48h: true,
  repoIssues: true,
  mergedRatio: true,
  authorAssociation: true,
  globalRecent48h: true,
  accountCreated: true,
  accountAge: true,
  publicRepos: true,
  followers: true,
  currentPrAge: true,
  currentPrSize: true
});
const APPEARANCE_MODES = new Set(["auto", "light", "dark"]);
const THEME_ATTRIBUTES = [
  "class",
  "data-color-mode",
  "data-dark-theme",
  "data-light-theme",
  "data-darkreader-mode",
  "data-darkreader-scheme",
  "style"
];

let activePageKey = "";
let activeRequestId = 0;
let activeAppearanceMode = "auto";
let activeContext = null;
let activeStats = null;
let mountTimer = 0;

bootstrap();

function bootstrap() {
  scheduleMount();

  document.addEventListener("turbo:load", scheduleMount);
  document.addEventListener("turbo:render", scheduleMount);
  document.addEventListener("pjax:end", scheduleMount);
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    syncDetectedTheme();
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }
    const panel = document.getElementById(PANEL_ID);
    if (panel && changes.appearanceMode) {
      applyPanelTheme(panel, changes.appearanceMode.newValue);
    }
    if (panel && changes[STAT_VISIBILITY_STORAGE_KEY] && activeContext && activeStats) {
      renderStats(
        panel,
        activeContext,
        activeStats,
        normalizeVisibleStats(changes[STAT_VISIBILITY_STORAGE_KEY].newValue)
      );
    }
  });

  const pageObserver = new MutationObserver(() => {
    if (!parsePullContext()) {
      return;
    }
    if (!document.getElementById(PANEL_ID)) {
      scheduleMount();
      return;
    }
    repositionPanel();
  });

  pageObserver.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true
  });

  const themeObserver = new MutationObserver(() => {
    syncDetectedTheme();
  });

  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: THEME_ATTRIBUTES
  });
}

function repositionPanel() {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) {
    return;
  }

  const anchor = findReviewersAnchor();
  if (anchor) {
    ensurePanel(anchor);
  }
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
    activeContext = null;
    activeStats = null;
    return;
  }

  const anchor = findReviewersAnchor();
  if (!anchor) {
    return;
  }

  const pageKey = `${context.owner}/${context.repo}#${context.pullNumber}`;
  const existingPanel = document.getElementById(PANEL_ID);
  if (!options.force && activePageKey === pageKey && existingPanel) {
    ensurePanel(anchor);
    return;
  }

  activePageKey = pageKey;
  activeContext = context;
  activeStats = null;
  const requestId = ++activeRequestId;

  const panel = ensurePanel(anchor);
  syncPanelTheme(panel);
  renderLoading(panel, context);

  let visibleStats = DEFAULT_VISIBLE_STATS;
  const visibleStatsPromise = loadVisibleStats().then((value) => {
    visibleStats = value;
    if (requestId === activeRequestId && activeStats) {
      renderStats(panel, context, activeStats, visibleStats);
    }
    return value;
  });
  const stats = await loadAuthorStats(context, options.force, (partialStats) => {
    if (requestId !== activeRequestId) {
      return;
    }
    activeStats = partialStats;
    renderStats(panel, context, partialStats, visibleStats);
  });
  await visibleStatsPromise;
  if (requestId !== activeRequestId) {
    return;
  }
  activeStats = stats;
  renderStats(panel, context, stats, visibleStats);
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
    return isSidebarHeading(element, "reviewers");
  });

  if (reviewersHeading) {
    return (
      reviewersHeading.closest(".discussion-sidebar-item") ||
      reviewersHeading.closest("section") ||
      reviewersHeading.closest("div") ||
      sidebar
    );
  }

  return findSidebarTopFallback(sidebar) || sidebar;
}

function isSidebarHeading(element, label) {
  const text = normalizeText(element.textContent);
  return text === label || text.startsWith(`${label} `);
}

function findSidebarTopFallback(sidebar) {
  const panel = document.getElementById(PANEL_ID);
  const items = Array.from(
    sidebar.querySelectorAll(":scope > .discussion-sidebar-item, :scope > section, :scope > div")
  ).filter((item) => item !== panel && !item.contains(panel));

  const bottomItem = items.find((item) => {
    const text = normalizeText(item.textContent);
    return text.includes("lock conversation") || text.includes("delete branch");
  });
  if (bottomItem) {
    const bottomIndex = items.indexOf(bottomItem);
    return bottomIndex > 0 ? items[bottomIndex - 1] : null;
  }

  return null;
}

function ensurePanel(anchor) {
  let panel = document.getElementById(PANEL_ID);
  if (!panel) {
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "mh-panel";
  }

  if (anchor.matches("#partial-discussion-sidebar, .Layout-sidebar, [data-testid='sidebar']")) {
    const firstChild = Array.from(anchor.children).find((child) => child !== panel);
    if (firstChild && firstChild !== panel.nextElementSibling) {
      anchor.insertBefore(panel, firstChild);
    } else if (panel.parentElement !== anchor) {
      anchor.append(panel);
    }
    return;
  }

  if (anchor.nextElementSibling !== panel) {
    anchor.insertAdjacentElement("afterend", panel);
  }

  return panel;
}

function syncPanelTheme(panel) {
  chrome.storage.local.get(["appearanceMode"], (values) => {
    applyPanelTheme(panel, values.appearanceMode);
  });
}

function applyPanelTheme(panel, value) {
  const appearanceMode = APPEARANCE_MODES.has(value) ? value : "auto";
  activeAppearanceMode = appearanceMode;
  if (appearanceMode === "auto") {
    const detectedTheme = detectPageTheme();
    panel.dataset.mhTheme = detectedTheme;
    panel.dataset.mhThemeSource = "auto";
    return;
  }
  panel.dataset.mhTheme = appearanceMode;
  panel.dataset.mhThemeSource = "manual";
}

function syncDetectedTheme(panel = document.getElementById(PANEL_ID)) {
  if (!panel || activeAppearanceMode !== "auto") {
    return;
  }
  const detectedTheme = detectPageTheme();
  panel.dataset.mhTheme = detectedTheme;
  panel.dataset.mhThemeSource = "auto";
}

function detectPageTheme() {
  const darkReaderTheme = detectDarkReaderTheme();
  if (darkReaderTheme) {
    return darkReaderTheme;
  }

  const colorMode = document.documentElement.dataset.colorMode;
  if (colorMode === "dark" || colorMode === "light") {
    return colorMode;
  }

  const color = detectRenderedThemeColor() || detectCssVariableThemeColor();
  if (color) {
    return themeFromColor(color);
  }

  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function detectDarkReaderTheme() {
  const root = document.documentElement;
  const scheme = root.getAttribute("data-darkreader-scheme");
  if (scheme === "dark" || scheme === "light") {
    return scheme;
  }
  return root.hasAttribute("data-darkreader-mode") ? "dark" : null;
}

function detectRenderedThemeColor() {
  const candidates = [
    document.querySelector(".application-main"),
    document.querySelector(".Layout-main"),
    document.querySelector("[data-testid='repository-container-header']"),
    document.body,
    document.documentElement
  ];

  return candidates
    .map(readElementBackgroundColor)
    .find(Boolean);
}

function readElementBackgroundColor(element) {
  let current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    if (current.id === PANEL_ID) {
      current = current.parentElement;
      continue;
    }
    const color = parseCssColor(getComputedStyle(current).backgroundColor);
    if (color && color.alpha !== 0) {
      return color;
    }
    current = current.parentElement;
  }
  return null;
}

function detectCssVariableThemeColor() {
  if (!document.body) {
    return null;
  }

  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = [
    "background: var(--bgColor-default, var(--color-canvas-default, transparent))",
    "height: 0",
    "left: -9999px",
    "overflow: hidden",
    "pointer-events: none",
    "position: fixed",
    "top: -9999px",
    "visibility: hidden",
    "width: 0"
  ].join(";");
  document.body.append(probe);

  try {
    const color = parseCssColor(getComputedStyle(probe).backgroundColor);
    return color && color.alpha !== 0 ? color : null;
  } finally {
    probe.remove();
  }
}

function themeFromColor(color) {
  return colorLuminance(color) < 0.45 ? "dark" : "light";
}

function parseCssColor(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  if (text === "transparent") {
    return { red: 0, green: 0, blue: 0, alpha: 0 };
  }

  let match = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (match) {
    const hex = match[1].length === 3
      ? match[1].split("").map((char) => char + char).join("")
      : match[1];
    return {
      red: Number.parseInt(hex.slice(0, 2), 16),
      green: Number.parseInt(hex.slice(2, 4), 16),
      blue: Number.parseInt(hex.slice(4, 6), 16),
      alpha: 1
    };
  }

  match = text.match(/^rgba?\(([^)]+)\)$/i);
  if (!match) {
    return null;
  }

  const parts = match[1]
    .replace(/\//g, " ")
    .split(match[1].includes(",") ? "," : /\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 3) {
    return null;
  }

  return {
    red: parseRgbChannel(parts[0]),
    green: parseRgbChannel(parts[1]),
    blue: parseRgbChannel(parts[2]),
    alpha: parts[3] === undefined ? 1 : parseAlphaChannel(parts[3])
  };
}

function parseRgbChannel(value) {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return value.endsWith("%") ? Math.round((number / 100) * 255) : number;
}

function parseAlphaChannel(value) {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) {
    return 1;
  }
  return value.endsWith("%") ? number / 100 : number;
}

function colorLuminance({ red, green, blue }) {
  const toLinear = (channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLinear(red) + 0.7152 * toLinear(green) + 0.0722 * toLinear(blue);
}

function removePanel() {
  const panel = document.getElementById(PANEL_ID);
  if (panel) {
    panel.remove();
  }
}

async function loadAuthorStats(context, forceRefresh, onUpdate) {
  const pull = await githubGet(
    `/repos/${context.owner}/${context.repo}/pulls/${context.pullNumber}`,
    {},
    forceRefresh ? 0 : CACHE_SHORT_MS
  );

  const login = pull.user && pull.user.login;
  if (!login) {
    throw new Error("Could not read the PR author from the GitHub API response.");
  }

  const requests = buildSearchRequests(context, login, forceRefresh);
  const initialAuthorRepoStats = {
    authorAssociation: pull.author_association || null,
    searchResults: requests.map(createPendingSearchResult),
    user: createPendingUser(login, pull),
    userError: null,
    userState: "loading"
  };
  onUpdate?.(buildAuthorStats(pull, initialAuthorRepoStats));

  const authorRepoStats = await loadAuthorRepoStats(
    context,
    login,
    pull,
    forceRefresh,
    requests,
    (partialAuthorRepoStats) => {
      onUpdate?.(buildAuthorStats(pull, partialAuthorRepoStats));
    }
  );
  return buildAuthorStats(pull, authorRepoStats);
}

function buildAuthorStats(pull, authorRepoStats) {
  const pullForStats = {
    ...pull,
    author_association: authorRepoStats.authorAssociation || pull.author_association
  };

  const counts = Object.fromEntries(
    authorRepoStats.searchResults.map((result) => [result.id, result])
  );

  const candidateSignal = scoreAuthor({
    pull: pullForStats,
    user: authorRepoStats.user,
    counts
  });
  const searchLoading = authorRepoStats.searchResults.some((result) => result.loading);
  const searchFailed = authorRepoStats.searchResults.some(
    (result) => !result.loading && !result.ok
  );
  const loading = authorRepoStats.userState === "loading" || searchLoading;
  const incomplete = authorRepoStats.userState === "error" || searchFailed;

  let signal = candidateSignal;
  if (candidateSignal.tone !== "trusted" && loading) {
    signal = {
      level: "Checking",
      tone: "pending",
      pending: true,
      message: "Loading author history and profile metrics...",
      score: null,
      signals: []
    };
  } else if (candidateSignal.tone !== "trusted" && incomplete) {
    signal = {
      level: "Partial",
      tone: "pending",
      pending: true,
      message: "Some metrics are unavailable, so the risk score is incomplete.",
      score: null,
      signals: []
    };
  }

  return {
    pull: pullForStats,
    user: authorRepoStats.user,
    counts,
    signal,
    loading,
    userError: authorRepoStats.userError,
    userState: authorRepoStats.userState
  };
}

async function loadAuthorRepoStats(
  context,
  login,
  pull,
  forceRefresh,
  requests,
  onUpdate
) {
  const cacheTtlMs = await loadAuthorRepoCacheTtlMs();
  const cacheKey = authorRepoCacheKey(context, login);

  if (!forceRefresh && cacheTtlMs > 0) {
    const cachedStats = await getAuthorRepoCachedStats(cacheKey, requests, cacheTtlMs);
    if (cachedStats) {
      const readyCachedStats = {
        ...cachedStats,
        userError: null,
        userState: "ready"
      };
      onUpdate?.(readyCachedStats);
      return readyCachedStats;
    }
  }

  const apiCacheTtlMs = forceRefresh ? 0 : cacheTtlMs > 0 ? cacheTtlMs : undefined;
  const authorAssociation = pull.author_association || null;
  let user = createPendingUser(login, pull);
  let userError = null;
  let userState = "loading";
  const searchResults = requests.map(createPendingSearchResult);
  const emitUpdate = () => {
    onUpdate?.({
      authorAssociation,
      searchResults: [...searchResults],
      user,
      userError,
      userState
    });
  };
  emitUpdate();

  const userPromise = githubGet(`/users/${login}`, {}, apiCacheTtlMs ?? CACHE_LONG_MS)
    .then((loadedUser) => {
      user = loadedUser;
      userState = "ready";
      emitUpdate();
    })
    .catch((error) => {
      userError = error instanceof Error ? error.message : String(error);
      userState = "error";
      emitUpdate();
    });
  const searchPromises = requests.map((request, index) => {
    return runSearchRequest({ ...request, ttlMs: apiCacheTtlMs ?? request.ttlMs }).then(
      (result) => {
        searchResults[index] = result;
        emitUpdate();
      }
    );
  });
  await Promise.all([userPromise, ...searchPromises]);

  if (cacheTtlMs > 0 && userState === "ready" && searchResults.every((result) => result.ok)) {
    const createdAt = Date.now();
    await setLocalStorageValue(cacheKey, {
      createdAt,
      expiresAt: createdAt + cacheTtlMs,
      authorAssociation,
      results: serializeSearchResults(searchResults),
      user: serializeUser(user)
    }).catch((error) => {
      console.warn(`Meerkat author cache write skipped: ${error.message}`);
    });
  }
  return { authorAssociation, searchResults, user, userError, userState };
}

function createPendingUser(login, pull) {
  return {
    created_at: null,
    followers: null,
    html_url: pull.user && pull.user.html_url
      ? pull.user.html_url
      : `https://github.com/${login}`,
    login,
    public_repos: null
  };
}

function createPendingSearchResult(request) {
  return {
    ...request,
    count: null,
    loading: true,
    ok: false
  };
}

function loadVisibleStats() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STAT_VISIBILITY_STORAGE_KEY], (values) => {
      resolve(normalizeVisibleStats(values[STAT_VISIBILITY_STORAGE_KEY]));
    });
  });
}

function normalizeVisibleStats(value) {
  const visibleStats = {};
  Object.keys(DEFAULT_VISIBLE_STATS).forEach((key) => {
    visibleStats[key] = !value || value[key] !== false;
  });
  return visibleStats;
}

function loadAuthorRepoCacheTtlMs() {
  return new Promise((resolve) => {
    chrome.storage.local.get([AUTHOR_REPO_CACHE_TTL_STORAGE_KEY], (values) => {
      resolve(normalizeAuthorRepoCacheTtlMs(values[AUTHOR_REPO_CACHE_TTL_STORAGE_KEY]));
    });
  });
}

function normalizeAuthorRepoCacheTtlMs(value) {
  const hours = Number.parseFloat(value);
  if (!Number.isFinite(hours)) {
    return DEFAULT_AUTHOR_REPO_CACHE_TTL_HOURS * MS_PER_HOUR;
  }
  return Math.max(0, Math.min(hours, MAX_AUTHOR_REPO_CACHE_TTL_HOURS)) * MS_PER_HOUR;
}

function isStatVisible(visibleStats, key) {
  return !visibleStats || visibleStats[key] !== false;
}

function buildSearchRequests(context, login, forceRefresh) {
  const ownerRepo = `${context.owner}/${context.repo}`;
  const sinceIso = new Date(Date.now() - RECENT_WINDOW_HOURS * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");

  const requests = [
    {
      id: "repoMerged",
      label: "Merged in repo",
      query: `repo:${ownerRepo} is:pr author:${login} is:merged`,
      link: repoPullsLink(context, `is:pr author:${login} is:merged`)
    },
    {
      id: "repoTotal",
      label: "Repo PRs",
      query: `repo:${ownerRepo} is:pr author:${login}`,
      link: repoPullsLink(context, `is:pr author:${login}`)
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
    cacheKey: `search:${context.owner.toLowerCase()}/${context.repo.toLowerCase()}/${login.toLowerCase()}/${request.id}`,
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
      request.ttlMs,
      request.cacheKey
    );

    return {
      ...request,
      ok: true,
      count: data.total_count || 0,
      incomplete: Boolean(data.incomplete_results),
      loading: false
    };
  } catch (error) {
    return {
      ...request,
      ok: false,
      count: null,
      error: error instanceof Error ? error.message : String(error),
      loading: false
    };
  }
}

async function getAuthorRepoCachedStats(cacheKey, requests, cacheTtlMs) {
  const cached = await getLocalStorageValue(cacheKey);
  if (!cached || !Number.isFinite(cached.createdAt)) {
    return null;
  }
  const requestedExpiresAt = cached.createdAt + cacheTtlMs;
  const expiresAt = Number.isFinite(cached.expiresAt)
    ? Math.min(cached.expiresAt, requestedExpiresAt)
    : requestedExpiresAt;
  if (Date.now() >= expiresAt) {
    await removeLocalStorageValue(cacheKey).catch(() => {});
    return null;
  }
  if (!isCachedUser(cached.user)) {
    return null;
  }
  if (!cached.results || typeof cached.results !== "object") {
    return null;
  }

  const searchResults = requests.map((request) => {
    const cachedResult = cached.results[request.id];
    if (!cachedResult || typeof cachedResult !== "object") {
      return null;
    }
    return {
      ...request,
      ok: cachedResult.ok === true,
      count: Number.isFinite(cachedResult.count) ? cachedResult.count : null,
      incomplete: Boolean(cachedResult.incomplete),
      error: typeof cachedResult.error === "string" ? cachedResult.error : undefined,
      loading: false
    };
  });

  if (!searchResults.every(Boolean)) {
    return null;
  }

  return {
    authorAssociation: typeof cached.authorAssociation === "string" ? cached.authorAssociation : null,
    searchResults,
    user: cached.user
  };
}

function serializeSearchResults(results) {
  return Object.fromEntries(
    results.map((result) => [
      result.id,
      {
        ok: result.ok === true,
        count: Number.isFinite(result.count) ? result.count : null,
        incomplete: Boolean(result.incomplete),
        error: result.error || null
      }
    ])
  );
}

function serializeUser(user) {
  return {
    created_at: user.created_at || null,
    followers: Number.isFinite(user.followers) ? user.followers : 0,
    html_url: user.html_url || null,
    login: user.login || null,
    public_repos: Number.isFinite(user.public_repos) ? user.public_repos : 0
  };
}

function isCachedUser(user) {
  return (
    user &&
    typeof user === "object" &&
    typeof user.login === "string" &&
    typeof user.created_at === "string" &&
    Number.isFinite(user.public_repos) &&
    Number.isFinite(user.followers)
  );
}

function authorRepoCacheKey(context, login) {
  return `${AUTHOR_REPO_CACHE_PREFIX}${context.owner.toLowerCase()}/${context.repo.toLowerCase()}/${login.toLowerCase()}`;
}

async function githubGet(path, params = {}, cacheTtlMs = CACHE_MEDIUM_MS, cacheKey = null) {
  const url = new URL(path, API_ORIGIN);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, value);
    }
  });

  const response = await sendRuntimeMessage({
    type: "mh:github-request",
    url: url.toString(),
    cacheKey: cacheKey || url.toString(),
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
    const attempts = response && response.attempts > 1
      ? ` after ${response.attempts} attempts`
      : "";
    const requestId = response && response.requestId
      ? ` [Request ID: ${response.requestId}]`
      : "";
    throw new Error(`${detail}${status}${attempts}${requestId}`);
  }

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

function getLocalStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, resolve);
  });
}

async function getLocalStorageValue(key) {
  const values = await getLocalStorage([key]);
  return values[key];
}

async function setLocalStorageValue(key, value) {
  const response = await sendRuntimeMessage({
    type: "mh:cache-set",
    key,
    value
  });
  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : "Cache write failed.");
  }
}

function removeLocalStorageValue(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove([key], () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
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
        <div class="mh-actions">
          <span class="mh-spinner" aria-hidden="true"></span>
        </div>
      </div>
      <p>Loading ${escapeHtml(context.owner)}/${escapeHtml(context.repo)} PR data...</p>
    </div>
  `;
}

function renderStats(panel, context, stats, visibleStats = DEFAULT_VISIBLE_STATS) {
  const { pull, user, counts, signal, userError, userState } = stats;
  const visible = normalizeVisibleStats(visibleStats);
  const profileUrl = user.html_url || `https://github.com/${user.login}`;
  const mergedRatio = counts.repoMerged?.loading || counts.repoTotal?.loading
    ? "Loading…"
    : ratioText(getCount(counts.repoMerged), getCount(counts.repoTotal));
  const statRows = [
    ["repoTotal", () => renderLinkedStat(counts.repoTotal)],
    ["repoMerged", () => renderLinkedStat(counts.repoMerged)],
    ["repoOpen", () => renderLinkedStat(counts.repoOpen)],
    ["repoClosedUnmerged", () => renderLinkedStat(counts.repoClosedUnmerged)],
    ["repoRecent48h", () => renderLinkedStat(counts.repoRecent48h)],
    ["repoIssues", () => renderLinkedStat(counts.repoIssues)],
    ["mergedRatio", () => renderPlainStat("Merged ratio here", mergedRatio)],
    ["authorAssociation", () => renderPlainStat("Author association", pull.author_association || "UNKNOWN")],
    ["globalRecent48h", () => renderLinkedStat(counts.globalRecent48h)],
    ["accountCreated", () => renderProfileStat("Account created", formatDate(user.created_at), profileUrl, userState, userError)],
    ["accountAge", () => renderProfileStat("Account age", formatDurationDays(daysSince(user.created_at)), profileUrl, userState, userError)],
    ["publicRepos", () => renderProfileStat("Public repos", formatNumber(user.public_repos), `${profileUrl}?tab=repositories`, userState, userError)],
    ["followers", () => renderProfileStat("Followers", formatNumber(user.followers), `${profileUrl}?tab=followers`, userState, userError)],
    ["currentPrAge", () => renderPlainStat("Current PR age", formatDurationDays(daysSince(pull.created_at)))],
    ["currentPrSize", () => renderPlainStat("Current PR size", formatPrSize(pull))]
  ]
    .filter(([key]) => isStatVisible(visible, key))
    .map(([, render]) => render())
    .join("");

  panel.innerHTML = `
    <div class="mh-card">
      <div class="mh-title-row">
        <h3>Author statistics</h3>
        <div class="mh-actions">
          ${stats.loading ? '<span class="mh-spinner" aria-label="Loading more statistics"></span>' : ""}
          <button type="button" class="mh-button mh-refresh">Refresh</button>
          <button type="button" class="mh-button mh-options">Options</button>
        </div>
      </div>

      <div class="mh-author-row">
        <a href="${escapeAttribute(profileUrl)}" target="_blank" rel="noreferrer">@${escapeHtml(user.login)}</a>
        <span class="mh-pill mh-pill-${signal.tone}">${escapeHtml(signal.level)}</span>
      </div>

      ${isStatVisible(visible, "signals") ? renderSignals(signal) : ""}
      ${statRows ? `<dl class="mh-stat-list">${statRows}</dl>` : ""}
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
  if (signal.pending) {
    return `<div class="mh-signal">${escapeHtml(signal.message)}</div>`;
  }
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
  if (!stat || stat.loading) {
    return renderPendingStat(stat ? stat.label : "Statistic");
  }
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

function renderProfileStat(label, value, url, state = "ready", error = null) {
  if (state === "loading") {
    return renderPendingStat(label);
  }
  if (state === "error") {
    return renderUnavailableStat(label, error);
  }
  return `
    <div class="mh-stat">
      <dt>${escapeHtml(label)}</dt>
      <dd><a href="${escapeAttribute(url)}" target="_blank" rel="noreferrer">${escapeHtml(value)}</a></dd>
    </div>
  `;
}

function renderPendingStat(label) {
  return `
    <div class="mh-stat mh-stat-pending">
      <dt>${escapeHtml(label)}</dt>
      <dd>Loading…</dd>
    </div>
  `;
}

function renderUnavailableStat(label, error) {
  const title = error ? ` title="${escapeAttribute(error)}"` : "";
  return `
    <div class="mh-stat"${title}>
      <dt>${escapeHtml(label)}</dt>
      <dd>Error</dd>
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
  if (!context) {
    return;
  }
  const anchor = findReviewersAnchor();
  if (!anchor) {
    return;
  }
  const panel = ensurePanel(anchor);
  syncPanelTheme(panel);
  const message = error instanceof Error ? error.message : String(error);
  panel.innerHTML = `
    <div class="mh-card mh-error">
      <div class="mh-title-row">
        <h3>Author statistics</h3>
        <div class="mh-actions">
          <button type="button" class="mh-button mh-options">Options</button>
        </div>
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
