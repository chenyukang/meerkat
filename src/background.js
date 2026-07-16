"use strict";

const API_ORIGIN = "https://api.github.com";
const CACHE_PREFIX = "mh:api:";
const AUTHOR_REPO_CACHE_PREFIX = "mh:author-repo:";
const CACHE_PREFIXES = [CACHE_PREFIX, AUTHOR_REPO_CACHE_PREFIX];
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const STORAGE_SOFT_LIMIT_BYTES = 8 * 1024 * 1024;
const STORAGE_TARGET_BYTES = 6 * 1024 * 1024;
const TRANSIENT_GITHUB_STATUSES = new Set([500, 502, 503, 504]);
const SEARCH_API_PATH = "/search/issues";
const DEFAULT_SEARCH_BACKOFF_MS = 60 * 1000;
const IMPORTANT_TRANSIENT_RETRIES = 3;
const SEARCH_TRANSIENT_RETRIES = 1;
const RETRY_BASE_DELAY_MS = 400;
const RETRY_MAX_DELAY_MS = 10 * 1000;

let searchRequestQueue = Promise.resolve();
let searchRateLimitedUntil = 0;
let anonymousSearchRateLimitedUntil = 0;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.type === "mh:github-request") {
    handleGithubRequest(message)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          status: 0,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    return true;
  }

  if (message.type === "mh:cache-set") {
    handleCacheWrite(message)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    return true;
  }

  if (message.type === "mh:open-options") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function handleGithubRequest(message) {
  const url = normalizeApiUrl(message.url);
  const method = message.method || "GET";
  if (method !== "GET") {
    throw new Error("Only GET requests are supported.");
  }

  const ttlMs = normalizeTtl(message.cacheTtlMs);
  const cacheKey = `${CACHE_PREFIX}${message.cacheKey || url.toString()}`;

  if (ttlMs > 0) {
    const cached = await getStorageValue(cacheKey);
    if (cached) {
      const expiresAt = cacheExpiresAt(cached, ttlMs);
      if (Date.now() < expiresAt) {
        return { ...cached.payload, cached: true };
      }
      await removeStorageValues([cacheKey]).catch(() => {});
    }
  }

  const settings = await getStorage(["githubToken"]);
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };

  if (settings.githubToken) {
    headers.Authorization = `Bearer ${settings.githubToken}`;
  }

  const { response, anonymousFallback, attempts } = await scheduleGithubRequest(url, () =>
    fetchGithubWithFallback(url, headers, Boolean(settings.githubToken))
  );

  const parsed = await parseJsonResponse(response);
  const payload = {
    ok: response.ok && parsed.isJson,
    status: response.status,
    data: parsed.data,
    rate: readRateLimit(response.headers),
    requestId: response.headers.get("x-github-request-id"),
    cached: false,
    anonymousFallback,
    attempts
  };

  if (payload.ok && ttlMs > 0) {
    const createdAt = Date.now();
    await setCacheValue(cacheKey, {
      createdAt,
      expiresAt: createdAt + ttlMs,
      payload
    }).catch((error) => {
      console.warn(`Meerkat cache write skipped: ${error.message}`);
    });
  }

  return payload;
}

function scheduleGithubRequest(url, request) {
  if (url.pathname !== SEARCH_API_PATH) {
    return request();
  }

  const runSearchRequest = async () => {
    if (Date.now() < searchRateLimitedUntil) {
      return {
        response: createSearchRateLimitResponse(),
        anonymousFallback: false,
        attempts: 0
      };
    }

    const result = await request();
    updateSearchRateLimitBackoff(result.response);
    return result;
  };
  const scheduled = searchRequestQueue.then(runSearchRequest, runSearchRequest);
  searchRequestQueue = scheduled.then(
    () => undefined,
    () => undefined
  );
  return scheduled;
}

async function fetchGithubWithFallback(url, headers, hasToken) {
  const primaryResult = await fetchGithubWithRetries(
    url,
    headers,
    url.pathname === SEARCH_API_PATH
      ? SEARCH_TRANSIENT_RETRIES
      : IMPORTANT_TRANSIENT_RETRIES
  );
  let response = primaryResult.response;
  let attempts = primaryResult.attempts;
  let anonymousFallback = false;

  if (hasToken && TRANSIENT_GITHUB_STATUSES.has(response.status)) {
    if (url.pathname === SEARCH_API_PATH && Date.now() < anonymousSearchRateLimitedUntil) {
      return { response, anonymousFallback, attempts };
    }

    const anonymousHeaders = { ...headers };
    delete anonymousHeaders.Authorization;
    const anonymousResponse = await fetchGithub(url, anonymousHeaders);
    attempts += 1;
    if (anonymousResponse.ok) {
      await discardResponse(response);
      response = anonymousResponse;
      anonymousFallback = true;
    } else {
      if (url.pathname === SEARCH_API_PATH) {
        anonymousSearchRateLimitedUntil = Math.max(
          anonymousSearchRateLimitedUntil,
          rateLimitBackoffUntil(anonymousResponse)
        );
      }
      await discardResponse(anonymousResponse);
    }
  }

  return { response, anonymousFallback, attempts };
}

async function fetchGithubWithRetries(url, headers, retryLimit) {
  let attempts = 0;
  let response;

  while (true) {
    response = await fetchGithub(url, headers);
    attempts += 1;
    if (!TRANSIENT_GITHUB_STATUSES.has(response.status) || attempts > retryLimit) {
      return { response, attempts };
    }

    const delayMs = retryDelayMs(response, attempts - 1);
    await discardResponse(response);
    await wait(delayMs);
  }
}

function retryDelayMs(response, retryIndex) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, RETRY_MAX_DELAY_MS);
    }
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.min(Math.max(0, retryAt - Date.now()), RETRY_MAX_DELAY_MS);
    }
  }

  const exponentialDelay = RETRY_BASE_DELAY_MS * 2 ** retryIndex;
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.round(Math.min(exponentialDelay * jitter, RETRY_MAX_DELAY_MS));
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function discardResponse(response) {
  if (!response.body || typeof response.body.cancel !== "function") {
    return;
  }
  await response.body.cancel().catch(() => {});
}

function updateSearchRateLimitBackoff(response) {
  searchRateLimitedUntil = Math.max(searchRateLimitedUntil, rateLimitBackoffUntil(response));
}

function rateLimitBackoffUntil(response) {
  if (response.status !== 403 && response.status !== 429) {
    return 0;
  }

  const remaining = parseHeaderNumber(response.headers.get("x-ratelimit-remaining"));
  const retryAfterSeconds = parseHeaderNumber(response.headers.get("retry-after"));
  if (response.status !== 429 && remaining !== 0 && retryAfterSeconds === null) {
    return 0;
  }

  const resetSeconds = parseHeaderNumber(response.headers.get("x-ratelimit-reset"));
  const now = Date.now();
  const resetAt = resetSeconds === null ? 0 : resetSeconds * 1000;
  const retryAt = retryAfterSeconds === null ? 0 : now + retryAfterSeconds * 1000;
  return Math.max(
    resetAt,
    retryAt,
    now + (resetAt || retryAt ? 1000 : DEFAULT_SEARCH_BACKOFF_MS)
  );
}

function createSearchRateLimitResponse() {
  const resetSeconds = Math.ceil(searchRateLimitedUntil / 1000);
  return new Response(
    JSON.stringify({
      message: `GitHub Search API rate limit reached. Try again after ${new Date(
        searchRateLimitedUntil
      ).toISOString()}.`
    }),
    {
      status: 403,
      headers: {
        "content-type": "application/json",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetSeconds),
        "x-ratelimit-resource": "search"
      }
    }
  );
}

function parseHeaderNumber(value) {
  if (value === null || value === "") {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function fetchGithub(url, headers) {
  return fetch(url.toString(), {
    method: "GET",
    headers,
    credentials: "omit",
    cache: "no-store"
  });
}

function normalizeApiUrl(rawUrl) {
  const url = new URL(rawUrl, API_ORIGIN);
  if (url.origin !== API_ORIGIN) {
    throw new Error("Blocked non-GitHub API request.");
  }
  return url;
}

function normalizeTtl(value) {
  if (value === 0) {
    return 0;
  }
  if (!Number.isFinite(value)) {
    return DEFAULT_CACHE_TTL_MS;
  }
  return Math.max(0, Math.min(value, MAX_CACHE_TTL_MS));
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return { data: null, isJson: true };
  }
  try {
    return { data: JSON.parse(text), isJson: true };
  } catch (_error) {
    const message = TRANSIENT_GITHUB_STATUSES.has(response.status)
      ? "GitHub API is temporarily unavailable."
      : "GitHub API returned an unexpected non-JSON response.";
    return { data: { message }, isJson: false };
  }
}

function readRateLimit(headers) {
  return {
    limit: headers.get("x-ratelimit-limit"),
    remaining: headers.get("x-ratelimit-remaining"),
    reset: headers.get("x-ratelimit-reset"),
    resource: headers.get("x-ratelimit-resource")
  };
}

function getStorage(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (values) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(values);
    });
  });
}

async function getStorageValue(key) {
  const values = await getStorage([key]);
  return values[key];
}

function setStorageValue(key, value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function removeStorageValues(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function getStorageBytesInUse(keys) {
  if (typeof chrome.storage.local.getBytesInUse !== "function") {
    return Promise.resolve(0);
  }
  return new Promise((resolve, reject) => {
    chrome.storage.local.getBytesInUse(keys, (bytes) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(bytes);
    });
  });
}

async function handleCacheWrite(message) {
  if (!isCacheKey(message.key) || !message.value || typeof message.value !== "object") {
    throw new Error("Invalid cache entry.");
  }
  await setCacheValue(message.key, message.value);
  return { ok: true };
}

async function setCacheValue(key, value) {
  const currentBytes = await getStorageBytesInUse(null);
  const projectedBytes = currentBytes + estimateStorageBytes(key, value);
  if (projectedBytes > STORAGE_SOFT_LIMIT_BYTES) {
    await evictOldestCacheEntries(projectedBytes - STORAGE_TARGET_BYTES);
  }

  try {
    await setStorageValue(key, value);
  } catch (error) {
    if (!isQuotaError(error)) {
      throw error;
    }
    const removed = await evictOldestCacheEntries(
      STORAGE_SOFT_LIMIT_BYTES - STORAGE_TARGET_BYTES
    );
    if (!removed) {
      throw error;
    }
    await setStorageValue(key, value);
  }
}

async function evictOldestCacheEntries(minimumBytesToFree) {
  const values = await getStorage(null);
  const entries = Object.entries(values)
    .filter(([key]) => isCacheKey(key))
    .sort(([, left], [, right]) => cacheCreatedAt(left) - cacheCreatedAt(right));

  const keysToRemove = [];
  let estimatedFreedBytes = 0;
  for (const [key, value] of entries) {
    keysToRemove.push(key);
    estimatedFreedBytes += estimateStorageBytes(key, value);
    if (estimatedFreedBytes >= minimumBytesToFree) {
      break;
    }
  }

  if (!keysToRemove.length) {
    return false;
  }
  await removeStorageValues(keysToRemove);
  return true;
}

function cacheExpiresAt(cached, ttlMs) {
  const createdAt = cacheCreatedAt(cached);
  const requestedExpiresAt = createdAt + ttlMs;
  return Number.isFinite(cached.expiresAt)
    ? Math.min(cached.expiresAt, requestedExpiresAt)
    : requestedExpiresAt;
}

function cacheCreatedAt(value) {
  return value && Number.isFinite(value.createdAt) ? value.createdAt : 0;
}

function isCacheKey(key) {
  return typeof key === "string" && CACHE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function estimateStorageBytes(key, value) {
  return new TextEncoder().encode(key + JSON.stringify(value)).length;
}

function isQuotaError(error) {
  return error instanceof Error && /quota/i.test(error.message);
}
