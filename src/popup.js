"use strict";

const tokenState = document.getElementById("token-state");

chrome.storage.local.get(["githubToken", "appearanceMode"], (values) => {
  applyAppearanceMode(values.appearanceMode);
  tokenState.textContent = values.githubToken ? "GitHub token configured." : "No GitHub token configured.";
});

document.getElementById("open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

function applyAppearanceMode(value) {
  if (value === "light" || value === "dark") {
    document.documentElement.dataset.mhTheme = value;
    return;
  }
  delete document.documentElement.dataset.mhTheme;
}
