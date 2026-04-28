"use strict";

const tokenState = document.getElementById("token-state");

chrome.storage.local.get(["githubToken"], (values) => {
  tokenState.textContent = values.githubToken ? "GitHub token configured." : "No GitHub token configured.";
});

document.getElementById("open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
