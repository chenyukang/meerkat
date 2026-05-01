# Publish Checklist

## Before Upload

- Load the extension locally from `chrome://extensions`.
- Test on at least one public GitHub pull request page.
- Confirm the optional token flow works from the extension options page.
- Increment `manifest.json` `version` for every uploaded update.
- Rebuild the upload zip with `scripts/package.sh`.
- Rebuild the Firefox zip with `scripts/package-firefox.sh` if publishing a Firefox build.

## Chrome Web Store Dashboard

1. Register or sign in at the Chrome Developer Dashboard.
2. Upload `dist/meerkat-0.1.2.zip`.
3. Fill Store Listing using `docs/chrome-web-store-listing.md`.
4. Upload graphics from `assets/store/` and `assets/icons/meerkat-128.png`.
5. Fill Privacy fields using `docs/chrome-web-store-listing.md`.
6. Set visibility. Use unlisted or trusted testers first if you want a soft launch.
7. Submit for review.

## Current Release Package

```text
dist/meerkat-0.1.2.zip
```

## Firefox Build

```text
dist/meerkat-0.1.2-firefox.zip
```

The Firefox package is generated from the Chrome manifest with `background.scripts` instead of `background.service_worker` and a Gecko add-on ID.
