"use strict";

const tokenInput = document.getElementById("github-token");
const statusElement = document.getElementById("status");

document.getElementById("save-token").addEventListener("click", saveToken);
document.getElementById("test-token").addEventListener("click", testToken);
document.getElementById("clear-cache").addEventListener("click", clearCache);

loadOptions();

function loadOptions() {
  chrome.storage.local.get(["githubToken"], (values) => {
    tokenInput.value = values.githubToken || "";
  });
}

function saveToken() {
  chrome.storage.local.set({ githubToken: tokenInput.value.trim() }, () => {
    setStatus("Saved.");
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
