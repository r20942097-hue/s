# Filter v2 candidate

This directory contains the next-generation candidate set. The existing root `ad.txt` and `tracking.txt` remain unchanged while v2 is evaluated.

## Recommended profiles

### Balanced
Subscribe to `ad.txt` only. This is the default recommendation. It blocks third-party advertising networks, including expanded Japanese ad-tech coverage, while avoiding cosmetic filters and first-party blocking.

### Balanced + Privacy
Subscribe to `ad.txt` and `tracking.txt`. This additionally blocks third-party analytics, session replay, telemetry, and advertising measurement. Some analytics or feedback features may stop working.

### Strict Privacy
Subscribe to all three lists. `strict.txt` additionally blocks tag managers, identity-linked measurement, and attribution frameworks. It has a materially higher site-breakage risk.

## Design rules

- Network rules are narrowed to third-party requests where practical.
- No broad generic cosmetic selectors.
- No paywall bypass or anti-adblock circumvention.
- No first-party blocking by default.
- No `important` modifier in the balanced lists, so local/user exceptions retain control.
- High-breakage categories are isolated in `strict.txt`.

## Subscription URLs

- https://raw.githubusercontent.com/r20942097-hue/s/main/v2/ad.txt
- https://raw.githubusercontent.com/r20942097-hue/s/main/v2/tracking.txt
- https://raw.githubusercontent.com/r20942097-hue/s/main/v2/strict.txt

## Status

Candidate. Syntax and public retrieval should be verified before replacing the root stable lists. Real-site regression testing is still required before calling v2 fully validated.
