# Chrome Web Store Listing Draft

## Product Details

Name:

```text
Meerkat
```

Short description:

```text
Adds GitHub PR author statistics to help maintainers spot suspicious pull requests.
```

Detailed description:

```text
Meerkat helps GitHub repository maintainers review pull request authors faster.

On GitHub pull request pages, Meerkat adds an author statistics panel near the reviewers area. It shows repository-specific history first, including authored PRs, merged PRs, open PRs, closed unmerged PRs, recent PRs, issues, merge ratio, and author association.

Meerkat also shows account-level context such as account creation date, account age, public repository count, followers, recent pull request activity across GitHub, and the current pull request size.

All statistics are shown by default, and users can choose which individual rows are visible from the extension options page.

The panel highlights trusted contributors when the author is a repository member or owner, or when the author has more than 20 merged PRs in the repository. It also flags basic watch signals such as very new accounts, no prior repository history, and bursty PR creation.

Meerkat works without a GitHub token, but GitHub's unauthenticated API limits are low. You can optionally add a GitHub personal access token in the extension options page to improve rate limits. For public repositories, the token does not need any scopes.

Meerkat does not use analytics, tracking, advertising, or a developer-operated backend. The optional token and API cache are stored locally in Chrome extension storage.
```

Category:

```text
Developer Tools
```

Language:

```text
English
```

Homepage URL:

```text
https://github.com/chenyukang/meerkat
```

Privacy policy URL:

```text
https://github.com/chenyukang/meerkat/blob/main/PRIVACY.md
```

## Graphic Assets

Store icon:

```text
assets/icons/meerkat-128.png
```

Screenshot:

```text
assets/store/screenshot-1280x800.png
```

Small promo tile:

```text
assets/store/small-promo-440x280.png
```

Marquee promo tile:

```text
assets/store/marquee-promo-1400x560.png
```

## Privacy Fields

Single purpose:

```text
Meerkat helps GitHub repository maintainers assess pull request author history and spam risk on GitHub pull request pages.
```

Permission justification for `storage`:

```text
Used to store an optional GitHub token entered by the user and a local GitHub API response cache to reduce repeated requests.
```

Host permission justification for `https://api.github.com/*`:

```text
Used to fetch GitHub pull request, user, and search metadata needed to display author statistics.
```

Remote code:

```text
No. Meerkat does not load or execute remotely hosted code.
```

Data disclosure note:

```text
Meerkat stores the optional GitHub token locally in Chrome extension storage and sends it only to GitHub API requests when configured. Meerkat does not send data to the developer, does not run analytics, and does not use a backend service.
```

## Test Instructions For Reviewers

```text
1. Install the extension.
2. Open a public GitHub pull request page, for example https://github.com/rust-lang/rust/pull/100091.
3. Wait for the "Author statistics" panel to appear in the pull request sidebar near the reviewers area.
4. Verify that repository PR counts, account age, author association, and current PR size are shown.
5. Optional: open the extension options page, toggle individual visible statistics, and add a GitHub token to increase GitHub API rate limits. Public repository testing does not require any token scopes.
```
