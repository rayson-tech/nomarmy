# Playwright browser harness

Installs Chromium and its OS dependencies using the repository's installed
@playwright/test version, after the Node dependency layer. Commit a supported
Node lockfile. Root and discovered nested packages are supported; browsers live
in /ms-playwright and are readable by the node user. Installation failure leaves
a .nomarmy-playwright-install-failed marker in /ms-playwright.

Select the browser verification profile (npx playwright test) in .nomarmy.yml:

```yaml
verification:
  browser:
    commands: [npx playwright test]
    environment: none
```

Allow at least 1024 MB memory. nomArmy's verification container allocates 512 MB
/dev/shm (or the largest shared-memory requirement of the matched harnesses).
For OpenClaw-managed worker sandboxes, unless OpenClaw exposes a shm setting,
launch Chromium with --disable-dev-shm-usage via Playwright launchOptions, as
the fixture does.

The fixture opens its own static HTML with file://: the test needs no network.
Install its npm dependencies and Chromium before running offline.

Screenshots, traces and reports under test-results/** and playwright-report/**
become job evidence under artifacts/, listed in verification.artifacts.
Collection is limited to 200 files and 50 MB; a cap is reported in verification.
Most of the time the General checks the UI itself after merging. This harness
is for repositories with a real end-to-end suite as their gate.
