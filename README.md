# Meerkat

Chrome MV3 extension that adds an author statistics panel to GitHub pull request pages.

<img src="assets/screenshots/pr-author-statistics.png" alt="Meerkat author statistics panel" width="365">

## What It Shows

- PR author history in the current repository: total, merged, open, closed unmerged.
- PRs created by the author across GitHub in the last 48 hours.
- PRs created by the author in the current repository in the last 48 hours.
- Author account creation date, account age, public repositories, followers.
- GitHub `author_association`, current PR age, file count, commit count, additions, and deletions.
- A conservative signal level based on account age, repo history, merged history, bursty PR creation, and current PR size.

Each count links to the matching GitHub search page.

All statistics are visible by default. Open the extension options page to hide individual rows and save that display preference locally.

## Load Locally In Chrome

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose Load unpacked.
4. Select this directory: `/code/to/to/Meerkat`.
5. Open a PR page such as `https://github.com/rust-lang/rust/pull/155901`.

## Build And Load In Firefox

Firefox needs a different background script declaration than Chrome. Build the Firefox package with:

```sh
./scripts/package-firefox.sh
```

This creates `dist/meerkat-<version>-firefox.zip` with a Firefox-specific generated manifest.

To install it temporarily in Firefox:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click Load Temporary Add-on.
3. Select the generated Firefox zip in `dist/`, or select `dist/firefox/manifest.json`.
4. Open a GitHub PR page and test the Author statistics panel.

Temporary Firefox add-ons are removed when Firefox restarts. For permanent installation, submit the Firefox package to Mozilla Add-ons for signing.

## GitHub Token

The extension works without a token, but GitHub's unauthenticated API limits are low. Open the extension options and add a GitHub personal access token to get normal authenticated API limits.

For public repositories, the token does not need any scopes. When creating a fine-grained or classic token, leave every scope/permission unchecked unless you want to use it for something outside Meerkat.

The token is stored in `chrome.storage.local`.
