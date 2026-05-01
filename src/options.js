"use strict";

const tokenInput = document.getElementById("github-token");
const appearanceModeInput = document.getElementById("appearance-mode");
const visibleStatsContainer = document.getElementById("visible-stats");
const statusElement = document.getElementById("status");
const STAT_VISIBILITY_STORAGE_KEY = "visibleStats";
const STAT_OPTIONS = [
  { key: "signals", label: "Trust/spam signals" },
  { key: "repoTotal", label: "Repo PRs" },
  { key: "repoMerged", label: "Merged in repo" },
  { key: "repoOpen", label: "Open in repo" },
  { key: "repoClosedUnmerged", label: "Closed unmerged" },
  { key: "repoRecent48h", label: "Repo PRs in 48h" },
  { key: "repoIssues", label: "Repo issues" },
  { key: "mergedRatio", label: "Merged ratio here" },
  { key: "authorAssociation", label: "Author association" },
  { key: "globalRecent48h", label: "All PRs in 48h" },
  { key: "accountCreated", label: "Account created" },
  { key: "accountAge", label: "Account age" },
  { key: "publicRepos", label: "Public repos" },
  { key: "followers", label: "Followers" },
  { key: "currentPrAge", label: "Current PR age" },
  { key: "currentPrSize", label: "Current PR size" }
];

document.getElementById("save-token").addEventListener("click", saveToken);
document.getElementById("test-token").addEventListener("click", testToken);
document.getElementById("clear-cache").addEventListener("click", clearCache);
appearanceModeInput.addEventListener("change", saveAppearanceMode);
visibleStatsContainer.addEventListener("change", saveVisibleStats);

loadOptions();

function loadOptions() {
  chrome.storage.local.get(["githubToken", "appearanceMode", STAT_VISIBILITY_STORAGE_KEY], (values) => {
    tokenInput.value = values.githubToken || "";
    appearanceModeInput.value = normalizeAppearanceMode(values.appearanceMode);
    applyAppearanceMode(appearanceModeInput.value);
    renderVisibleStatsOptions(normalizeVisibleStats(values[STAT_VISIBILITY_STORAGE_KEY]));
  });
}

function saveToken() {
  chrome.storage.local.set({ githubToken: tokenInput.value.trim() }, () => {
    setStatus("Saved.");
  });
}

function saveAppearanceMode() {
  const appearanceMode = normalizeAppearanceMode(appearanceModeInput.value);
  appearanceModeInput.value = appearanceMode;
  applyAppearanceMode(appearanceMode);
  chrome.storage.local.set({ appearanceMode }, () => {
    setStatus("Appearance saved.");
  });
}

function saveVisibleStats() {
  const visibleStats = {};
  STAT_OPTIONS.forEach((option) => {
    const checkbox = visibleStatsContainer.querySelector(`[data-stat-key="${option.key}"]`);
    visibleStats[option.key] = checkbox ? checkbox.checked : true;
  });
  chrome.storage.local.set({ [STAT_VISIBILITY_STORAGE_KEY]: visibleStats }, () => {
    setStatus("Visible statistics saved.");
  });
}

async function testToken() {
  setStatus("Testing...");
  try {
    await saveTokenAsync();
    const response = await sendRuntimeMessage({
      type: "mh:github-request",
      url: "https://api.github.com/rate_limit",
      cacheTtlMs: 0
    });

    if (!response || !response.ok) {
      const message =
        response && response.data && response.data.message
          ? response.data.message
          : "Token test failed.";
      setStatus(message);
      return;
    }

    const core = response.data && response.data.resources && response.data.resources.core;
    const search = response.data && response.data.resources && response.data.resources.search;
    setStatus(
      `OK. Core remaining: ${core ? core.remaining : "N/A"}. Search remaining: ${
        search ? search.remaining : "N/A"
      }.`
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  }
}

function clearCache() {
  chrome.storage.local.get(null, (values) => {
    const keys = Object.keys(values).filter((key) => key.startsWith("mh:api:"));
    if (!keys.length) {
      setStatus("No cached API responses.");
      return;
    }
    chrome.storage.local.remove(keys, () => {
      setStatus(`Cleared ${keys.length} cached responses.`);
    });
  });
}

function saveTokenAsync() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ githubToken: tokenInput.value.trim() }, resolve);
  });
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

function setStatus(message) {
  statusElement.textContent = message;
}

function normalizeAppearanceMode(value) {
  return ["auto", "light", "dark"].includes(value) ? value : "auto";
}

function normalizeVisibleStats(value) {
  const visibleStats = {};
  STAT_OPTIONS.forEach((option) => {
    visibleStats[option.key] = !value || value[option.key] !== false;
  });
  return visibleStats;
}

function renderVisibleStatsOptions(visibleStats) {
  visibleStatsContainer.textContent = "";
  STAT_OPTIONS.forEach((option) => {
    const label = document.createElement("label");
    label.className = "checkbox-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = visibleStats[option.key];
    checkbox.dataset.statKey = option.key;

    const text = document.createElement("span");
    text.textContent = option.label;

    label.append(checkbox, text);
    visibleStatsContainer.append(label);
  });
}

function applyAppearanceMode(value) {
  const appearanceMode = normalizeAppearanceMode(value);
  if (appearanceMode === "auto") {
    delete document.documentElement.dataset.mhTheme;
    return;
  }
  document.documentElement.dataset.mhTheme = appearanceMode;
}
