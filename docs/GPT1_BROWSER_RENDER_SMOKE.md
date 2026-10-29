# GPT1 v2.6 — Isolated Firefox/Chromium real render smoke

## Purpose and evidence
- This is a **real browser process** validation against a local, static HTML + JavaScript fixture served from `127.0.0.1` only. No external URLs, user credentials, saved browser profiles or user product ZIPs.
- The test uses Python standard library `http.server`, `subprocess` and temporary working directories. Test artifacts are removed when the job finishes.
- Chromium: `--headless --dump-dom` must return DOM content containing a JavaScript-created marker (checks basic JavaScript execution and DOM serialization).
- Firefox: `--headless --screenshot` must create a valid PNG header with a plausible viewport size (checks headless page rendering). This **does not** assert Firefox DOM/JS execution specifically.
- Official references: [Chrome headless command line](https://developer.chrome.com/docs/automation-and-testing/headless-cli) and [Firefox command line](https://firefox-source-docs.mozilla.org/browser/CommandLineParameters.html).

## Security and sandbox trade-off
- Chromium **first attempts its default sandbox**. In the GitHub-hosted Ubuntu 24.04/26.04 runners at verification time, this attempt aborted with exit code `-6`, with sandbox/zygote-related diagnostic categories.
- The optional CLI flag `--allow-no-sandbox-ephemeral` permits exactly one extra Chromium attempt **only after this `-6` error**, and only against this script's generated localhost fixture. The result reports `sandbox: DISABLED_LOCAL_FIXTURE_ONLY` and `default_sandbox_attempt: ABORTED_-6`.
- **Never interpret a sandbox-disabled Chromium test as proof that a normal securely sandboxed Chromium launch is working.** Do not use this fallback for user extensions, real streaming sites, uploads, authenticated services, or normal browsing.
- Other failures do not trigger a fallback. Firefox uses its normal browser settings with a disposable test profile.
- No external downloaded binaries or packages are installed. GitHub Actions jobs run in isolated GitHub-hosted Linux runners with only `contents: read`, no persisted checkout credentials and no explicit authentication token for the browser process. External fork PRs are excluded from these browser-render jobs.

## Run
```bash
# faaff
python3 -m unittest discover -s ai/tests -p test_browser_render_smoke.py -v
python3 ai/browser_render_smoke.py --browser both --json

# CI synthetic fixture only; fallback after sandbox abort -6
python3 ai/browser_render_smoke.py --browser both --allow-no-sandbox-ephemeral --json

# s: replace ai/ with scripts/ for the verifier, tests live in tests/
```

If either browser render fails, the script exits with code 1 and reports FAIL. The CI suite tests the script's fail-closed behavior with unit tests and runs the real browsers on explicit `ubuntu-24.04` and `ubuntu-26.04` labels.

## Distinct quality gates

| Gate | What this can establish |
| --- | --- |
| Local synthetic Chromium DOM+JavaScript smoke | `PASS` if marker observed; sandbox mode separately disclosed |
| Local synthetic Firefox headless screenshot | `PASS` if valid PNG size and dimensions observed |
| Firefox and Chromium extension install | `NOT_RUN` |
| Manifest V3 background Service Worker | `NOT_RUN` |
| RPLAY / StreamHarbor / YouTube Optimizer real product E2E | `NOT_RUN` |
| Windows end-device browser compatibility | `NOT_RUN` |
| Product release approval | `CANDIDATE_NO_GO` |

For real extension E2E, first identify authentic source, target versions, build recipe and ZIP hash. Then use a separate isolated build and browser profile. Prefer Playwright's supported Chromium extension harness and Mozilla web-ext for Firefox; do not silently substitute a mock extension for a real artifact.

GitHub protection: existing Draft PRs only; no main merge, release or public subscription modifications.
