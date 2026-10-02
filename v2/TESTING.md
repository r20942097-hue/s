# v2 validation status

The automated validator checks metadata, subscription URLs, duplicate hosts, rule syntax, third-party scope, and disallowed modifiers. It does not verify that a host is currently serving ads or tracking, and it cannot measure false positives.

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
