"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const CONTENT_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "src", "content.js"),
  "utf8"
);

test("renders PR data immediately while author metrics are pending", () => {
  const context = loadContent();
  const pull = samplePull();
  const requests = context.buildSearchRequests(
    { owner: "rust-lang", repo: "rust", pullNumber: 1 },
    "example",
    false
  );
  const pending = {
    authorAssociation: pull.author_association,
    searchResults: requests.map(context.createPendingSearchResult),
    user: context.createPendingUser("example", pull),
    userError: null,
    userState: "loading"
  };

  const stats = context.buildAuthorStats(pull, pending);

  assert.equal(stats.loading, true);
  assert.equal(stats.signal.level, "Checking");
  assert.equal(stats.pull.changed_files, 2);
  assert.match(context.renderLinkedStat(stats.counts.repoMerged), /Loading…/);
  assert.match(
    context.renderProfileStat("Followers", "N/A", "https://github.com/example", "loading"),
    /Loading…/
  );
});

test("promotes a trusted signal as soon as the high-priority merged count arrives", () => {
  const context = loadContent();
  const pull = samplePull();
  const requests = context.buildSearchRequests(
    { owner: "rust-lang", repo: "rust", pullNumber: 1 },
    "example",
    false
  );
  const searchResults = requests.map(context.createPendingSearchResult);
  searchResults[0] = {
    ...requests[0],
    count: 641,
    incomplete: false,
    loading: false,
    ok: true
  };

  const stats = context.buildAuthorStats(pull, {
    authorAssociation: pull.author_association,
    searchResults,
    user: context.createPendingUser("example", pull),
    userError: null,
    userState: "loading"
  });

  assert.equal(requests[0].id, "repoMerged");
  assert.equal(stats.loading, true);
  assert.equal(stats.signal.level, "Trusted");
  assert.match(stats.signal.signals[0], /641/);
});

function loadContent() {
  const documentElement = {};
  const context = vm.createContext({
    URL,
    chrome: {
      runtime: {
        lastError: null,
        sendMessage() {}
      },
      storage: {
        local: {
          get(_keys, callback) {
            callback({});
          },
          remove(_keys, callback) {
            callback();
          }
        },
        onChanged: {
          addListener() {}
        }
      }
    },
    console: { warn() {} },
    document: {
      addEventListener() {},
      body: {},
      documentElement,
      getElementById() {
        return null;
      }
    },
    getComputedStyle() {
      return { backgroundColor: "rgb(255, 255, 255)" };
    },
    location: { pathname: "" },
    MutationObserver: class {
      observe() {}
    },
    Node: { ELEMENT_NODE: 1 },
    window: {
      clearTimeout() {},
      matchMedia() {
        return { addEventListener() {}, matches: false };
      },
      setTimeout() {
        return 1;
      }
    }
  });
  vm.runInContext(CONTENT_SOURCE, context, { filename: "content.js" });
  return context;
}

function samplePull() {
  return {
    additions: 3,
    author_association: "CONTRIBUTOR",
    changed_files: 2,
    commits: 1,
    created_at: "2026-07-17T00:00:00Z",
    deletions: 1,
    user: {
      html_url: "https://github.com/example",
      login: "example"
    }
  };
}
