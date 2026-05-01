# Meerkat Privacy Policy

Meerkat helps GitHub repository maintainers assess pull request author history and spam risk directly on GitHub pull request pages.

## Data Stored Locally

Meerkat may store the following data in Chrome extension storage on your device:

- An optional GitHub personal access token that you enter in the extension options page.
- Cached GitHub API responses used to reduce API requests and avoid rate limit pressure.

This data is stored with `chrome.storage.local`. It is not written to the extension source directory or to any repository.

## Data Sent To GitHub

Meerkat calls the GitHub API to fetch public pull request, user, and issue search metadata. If you configure a GitHub token, Meerkat sends that token only to `https://api.github.com` as an authorization header for GitHub API requests.

Meerkat does not send your token or browsing data to the extension developer or to any third-party analytics service.

## Data Sharing

Meerkat does not sell, rent, or share user data.

Meerkat does not use analytics, advertising SDKs, tracking pixels, or a developer-operated backend service.

## Permissions

Meerkat uses:

- `storage` to save the optional GitHub token and local API cache.
- `https://api.github.com/*` host access to query GitHub API endpoints.
- A content script on GitHub pull request pages to display author statistics in the pull request sidebar.

## Removing Data

You can remove the GitHub token from the extension options page. You can also remove all extension data by uninstalling Meerkat from Chrome.
