"use strict";

const API_ORIGIN = "https://api.github.com";
const CACHE_PREFIX = "mh:api:";
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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
    if (cached && Date.now() - cached.createdAt < ttlMs) {
      return { ...cached.payload, cached: true };
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

  const response = await fetch(url.toString(), {
    method,
    headers,
    credentials: "omit",
    cache: "no-store"
  });

  const payload = {
    ok: response.ok,
    status: response.status,
    data: await parseJsonResponse(response),
    rate: readRateLimit(response.headers),
    cached: false
  };

  if (response.ok && ttlMs > 0) {
    await setStorageValue(cacheKey, {
      createdAt: Date.now(),
      payload
    });
  }

  return payload;
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
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (_error) {
    return { message: text };
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
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, resolve);
  });
}

async function getStorageValue(key) {
  const values = await getStorage([key]);
  return values[key];
}

function setStorageValue(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}
