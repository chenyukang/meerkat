"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const BACKGROUND_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "src", "background.js"),
  "utf8"
);

test("retries an important authenticated 503 before anonymous fallback", async () => {
  const storage = createStorage({ githubToken: "old-token" });
  const requests = [];
  const context = loadBackground(storage.chrome, async (_url, options) => {
    requests.push(options);
    if (requests.length === 1) {
      return response("<html>unicorn error</html>", 503, {
        "content-type": "text/html",
        "x-github-request-id": "failed-request"
      });
    }
    return response(JSON.stringify({ number: 159406 }), 200, {
      "content-type": "application/json",
      "x-github-request-id": "fallback-request"
    });
  });

  const result = await context.handleGithubRequest({
    type: "mh:github-request",
    url: "https://api.github.com/repos/rust-lang/rust/pulls/159406",
    cacheTtlMs: 0
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers.Authorization, "Bearer old-token");
  assert.equal(requests[1].headers.Authorization, "Bearer old-token");
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.data.number, 159406);
  assert.equal(result.anonymousFallback, false);
  assert.equal(result.attempts, 2);
  assert.equal(result.requestId, "fallback-request");
});

test("honors Retry-After before retrying a transient response", async () => {
  const storage = createStorage({ githubToken: "valid-token" });
  const delays = [];
  let fetchCount = 0;
  const context = loadBackground(
    storage.chrome,
    async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return response("temporary", 503, { "retry-after": "2" });
      }
      return response(JSON.stringify({ login: "example" }), 200, {
        "content-type": "application/json"
      });
    },
    delays
  );

  const result = await context.handleGithubRequest({
    type: "mh:github-request",
    url: "https://api.github.com/users/example",
    cacheTtlMs: 0
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(delays, [2000]);
});

test("keeps a failed authenticated response but never exposes its HTML", async () => {
  const storage = createStorage({ githubToken: "old-token" });
  const context = loadBackground(storage.chrome, async (_url, options) => {
    const requestId = options.headers.Authorization ? "authenticated-request" : "anonymous-request";
    return response("<html>very long unicorn error page</html>", 503, {
      "content-type": "text/html",
      "x-github-request-id": requestId
    });
  });

  const result = await context.handleGithubRequest({
    type: "mh:github-request",
    url: "https://api.github.com/repos/private/repo/pulls/1",
    cacheTtlMs: 0
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.attempts, 5);
  assert.equal(result.requestId, "authenticated-request");
  assert.equal(result.data.message, "GitHub API is temporarily unavailable.");
  assert.equal(JSON.stringify(result).includes("unicorn"), false);
});

test("serializes concurrent search requests and their fallbacks", async () => {
  const storage = createStorage({ githubToken: "old-token" });
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  let authenticatedRequests = 0;
  let anonymousRequests = 0;
  const context = loadBackground(storage.chrome, async (_url, options) => {
    activeRequests += 1;
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
    await new Promise((resolve) => setImmediate(resolve));
    activeRequests -= 1;

    if (options.headers.Authorization) {
      authenticatedRequests += 1;
      return response("<html>temporary error</html>", 503, {
        "content-type": "text/html"
      });
    }

    anonymousRequests += 1;
    return response(JSON.stringify({ total_count: 1, items: [] }), 200, {
      "content-type": "application/json"
    });
  });

  const results = await Promise.all(
    ["merged", "open", "closed"].map((state) =>
      context.handleGithubRequest({
        type: "mh:github-request",
        url: `https://api.github.com/search/issues?q=${state}`,
        cacheTtlMs: 0
      })
    )
  );

  assert.equal(maximumActiveRequests, 1);
  assert.equal(authenticatedRequests, 6);
  assert.equal(anonymousRequests, 3);
  assert.equal(results.every((result) => result.attempts === 3), true);
  assert.equal(results.every((result) => result.ok && result.anonymousFallback), true);
});

test("stops queued search fetches until a reported rate-limit reset", async () => {
  const storage = createStorage({ githubToken: "valid-token" });
  const resetSeconds = Math.floor(Date.now() / 1000) + 60;
  let fetchCount = 0;
  const context = loadBackground(storage.chrome, async () => {
    fetchCount += 1;
    return response(JSON.stringify({ message: "API rate limit exceeded" }), 403, {
      "content-type": "application/json",
      "x-github-request-id": "rate-limited-request",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(resetSeconds),
      "x-ratelimit-resource": "search"
    });
  });

  const results = await Promise.all(
    ["merged", "open", "closed"].map((state) =>
      context.handleGithubRequest({
        type: "mh:github-request",
        url: `https://api.github.com/search/issues?q=${state}`,
        cacheTtlMs: 0
      })
    )
  );

  assert.equal(fetchCount, 1);
  assert.equal(results.every((result) => !result.ok && result.status === 403), true);
  assert.equal(results[0].requestId, "rate-limited-request");
  assert.match(results[1].data.message, /Try again after/);
  assert.equal(results[1].rate.remaining, "0");
});

test("stops anonymous search fallbacks without blocking authenticated searches", async () => {
  const storage = createStorage({ githubToken: "valid-token" });
  const resetSeconds = Math.floor(Date.now() / 1000) + 60;
  let authenticatedRequests = 0;
  let anonymousRequests = 0;
  const context = loadBackground(storage.chrome, async (_url, options) => {
    if (options.headers.Authorization) {
      authenticatedRequests += 1;
      return response("<html>temporary error</html>", 503, {
        "content-type": "text/html"
      });
    }

    anonymousRequests += 1;
    return response(JSON.stringify({ message: "API rate limit exceeded" }), 403, {
      "content-type": "application/json",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(resetSeconds),
      "x-ratelimit-resource": "search"
    });
  });

  const results = await Promise.all(
    ["merged", "open", "closed"].map((state) =>
      context.handleGithubRequest({
        type: "mh:github-request",
        url: `https://api.github.com/search/issues?q=${state}`,
        cacheTtlMs: 0
      })
    )
  );

  assert.equal(authenticatedRequests, 6);
  assert.equal(anonymousRequests, 1);
  assert.equal(results.every((result) => !result.ok && result.status === 503), true);
});

test("reuses a successful search response through its stable cache key", async () => {
  const storage = createStorage({ githubToken: "valid-token" });
  let fetchCount = 0;
  const context = loadBackground(storage.chrome, async () => {
    fetchCount += 1;
    return response(JSON.stringify({ total_count: 7, items: [] }), 200, {
      "content-type": "application/json",
      "x-ratelimit-remaining": "29",
      "x-ratelimit-resource": "search"
    });
  });
  const cacheKey = "search:rust-lang/rust/example/repoRecent48h";

  const first = await context.handleGithubRequest({
    type: "mh:github-request",
    url: "https://api.github.com/search/issues?q=created%3A%3E%3Dfirst",
    cacheKey,
    cacheTtlMs: 2 * 60 * 60 * 1000
  });
  const second = await context.handleGithubRequest({
    type: "mh:github-request",
    url: "https://api.github.com/search/issues?q=created%3A%3E%3Dsecond",
    cacheKey,
    cacheTtlMs: 2 * 60 * 60 * 1000
  });

  assert.equal(fetchCount, 1);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.data.total_count, 7);
});

test("evicts the oldest cache entries before reaching the storage quota", async () => {
  const largeValue = "x".repeat(2_600_000);
  const storage = createStorage({
    githubToken: "keep-me",
    visibleStats: { signals: true },
    "mh:api:oldest": { createdAt: 1, payload: largeValue },
    "mh:api:middle": { createdAt: 2, payload: largeValue },
    "mh:author-repo:newest": { createdAt: 3, payload: largeValue }
  });
  const context = loadBackground(storage.chrome, async () => {
    throw new Error("fetch should not be called");
  });

  await context.setCacheValue("mh:api:new", {
    createdAt: 4,
    payload: "y".repeat(1_000_000)
  });

  assert.equal(storage.data.githubToken, "keep-me");
  assert.deepEqual(storage.data.visibleStats, { signals: true });
  assert.equal(storage.data["mh:api:oldest"], undefined);
  assert.ok(storage.data["mh:api:middle"]);
  assert.ok(storage.data["mh:author-repo:newest"]);
  assert.ok(storage.data["mh:api:new"]);
});

test("handles a quota error, evicts cache only, and retries the write", async () => {
  const storage = createStorage(
    {
      githubToken: "keep-me",
      "mh:api:oldest": { createdAt: 1, payload: "old" },
      "mh:author-repo:newest": { createdAt: 2, payload: "new" }
    },
    { failSetsWithQuota: 1 }
  );
  const context = loadBackground(storage.chrome, async () => {
    throw new Error("fetch should not be called");
  });

  await context.setCacheValue("mh:api:replacement", {
    createdAt: 3,
    payload: "replacement"
  });

  assert.equal(storage.data.githubToken, "keep-me");
  assert.equal(storage.data["mh:api:oldest"], undefined);
  assert.equal(storage.data["mh:author-repo:newest"], undefined);
  assert.ok(storage.data["mh:api:replacement"]);
});

function loadBackground(chrome, fetchImpl, delays = []) {
  const context = vm.createContext({
    Response,
    URL,
    TextEncoder,
    chrome,
    console: { warn() {} },
    fetch: fetchImpl,
    setTimeout(callback, delayMs) {
      delays.push(delayMs);
      callback();
      return 1;
    }
  });
  vm.runInContext(BACKGROUND_SOURCE, context, { filename: "background.js" });
  return context;
}

function response(body, status, headers) {
  return new Response(body, { status, headers });
}

function createStorage(initialData, options = {}) {
  const data = structuredClone(initialData);
  let remainingQuotaFailures = options.failSetsWithQuota || 0;
  const runtime = {
    lastError: null,
    onMessage: {
      addListener() {}
    },
    openOptionsPage() {}
  };

  const local = {
    get(keys, callback) {
      callback(readStorageKeys(data, keys));
    },
    set(values, callback) {
      if (remainingQuotaFailures > 0) {
        remainingQuotaFailures -= 1;
        runtime.lastError = { message: "Resource::kQuotaBytes quota exceeded" };
        callback();
        runtime.lastError = null;
        return;
      }
      Object.assign(data, structuredClone(values));
      callback();
    },
    remove(keys, callback) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete data[key];
      }
      callback();
    },
    getBytesInUse(keys, callback) {
      const values = readStorageKeys(data, keys);
      const bytes = Object.entries(values).reduce((total, [key, value]) => {
        return total + Buffer.byteLength(key + JSON.stringify(value));
      }, 0);
      callback(bytes);
    }
  };

  return {
    chrome: {
      runtime,
      storage: { local }
    },
    data
  };
}

function readStorageKeys(data, keys) {
  if (keys === null) {
    return structuredClone(data);
  }
  const requestedKeys = Array.isArray(keys) ? keys : [keys];
  return Object.fromEntries(
    requestedKeys.filter((key) => Object.hasOwn(data, key)).map((key) => [key, data[key]])
  );
}
