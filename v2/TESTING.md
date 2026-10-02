# v2 validation status

The automated validator checks metadata, subscription URLs, duplicate hosts, rule syntax, third-party scope, and disallowed modifiers. It does not verify that a host is currently serving ads or tracking, and it cannot measure false positives.

The weekly overlap workflow downloads EasyList and EasyPrivacy and removes only custom third-party host rules covered by unrestricted upstream host rules. It does not add new rules, audit AdGuard/HaGeZi or root custom lists, or publish the result to stable subscriptions. Any change is proposed in a pull request for review.

The promotion gate binds evidence to SHA-256 hashes of the exact candidate filter bytes. For every rule it requires two immutable upstream snapshots with matching local bytes, a recorded source-independence review, a no-overlap audit, exception review, site regression, canary, and rollback evidence. Stable promotion additionally requires at least 14 elapsed days of recorded soak evidence. Evidence references must resolve to files inside the repository.

Run `python v2/scripts/validate_promotion.py --target canary --evidence evidence/current.json` to evaluate canary readiness. The current manifest intentionally returns `BLOCKED`: all 74 remaining rules lack per-rule evidence. This is the honest current status, not a CI failure.

## Required before promotion

Run the three lists separately in a disposable browser profile with the user's normal base filter lists enabled. Record the browser, operating system, extension and version, list URL and fetched revision, test date, and evidence for each case.

- Subscription succeeds and the list version shown by the blocker matches the tested commit.
- Representative Japanese and non-Japanese news, commerce, search, video, social, and reference sites load and remain usable.
- Check sign-in, search, checkout, media playback, embedded widgets, and first-party navigation.
- Confirm a known matching third-party request is blocked for each profile; do not use this as evidence that the entire list works.
- Compare behavior with the v2 list disabled to identify list-caused breakage.
- Disable the list and confirm affected site functions recover; record failures as failures, not passes.

Keep results for `ad.txt`, `tracking.txt`, and `strict.txt` distinct. Do not promote based only on CI or a small rule count. Any observed breakage or false positive should be reproduced, minimized to the responsible rule, and fixed or documented before promotion.

## Current status

CI and local static validation can establish syntax and declared policy only. Real-browser subscription, block-effectiveness, breakage, false-positive, and rollback checks remain `NOT RUN` until evidence is recorded.
