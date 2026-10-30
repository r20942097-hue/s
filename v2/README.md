# Filter v2 global candidate

This directory contains the global next-generation candidate set. The root stable profiles remain the default recommendation while v2 is evaluated. Both are generated from the canonical profile registry, with licenses kept separate.

## Scope

v2 is no longer Japan-focused. It combines a compact global supplement for widely used advertising and tracking infrastructure with selected regional rules. Japanese rules remain included as one regional subset.

Upstream projects reviewed on 2026-10-11:
- EasyList / EasyPrivacy
- AdGuard Base, Tracking Protection, and regional filters
- uBlock Origin uAssets

The lists intentionally remain much smaller than the upstream projects. They are supplements, not replacements for a maintained base list.

## Recommended profiles

### Balanced
Subscribe to `ad.txt` only. This blocks third-party advertising infrastructure while avoiding broad cosmetic filters and first-party blocking.

### Balanced + Privacy
Subscribe to `ad.txt` and `tracking.txt`. This additionally blocks third-party analytics, session replay, RUM, telemetry, and advertising measurement. Some analytics or feedback features may stop working.

### Strict Privacy
Subscribe to all three lists. `strict.txt` additionally blocks tag managers, identity-linked measurement, and attribution frameworks. It has a materially higher site-breakage risk.

## Design rules

- Network rules are narrowed to third-party requests where practical.
- No broad generic cosmetic selectors.
- No paywall bypass or anti-adblock circumvention.
- No first-party blocking by default.
- No `important` modifier in the balanced lists, so local/user exceptions retain control.
- Higher-breakage categories are isolated in `strict.txt`.
- Weakly verified or obsolete candidates are removed rather than retained just to increase rule count.

## Subscription URLs

- https://raw.githubusercontent.com/r20942097-hue/s/main/v2/ad.txt
- https://raw.githubusercontent.com/r20942097-hue/s/main/v2/tracking.txt
- https://raw.githubusercontent.com/r20942097-hue/s/main/v2/strict.txt

## Status

Candidate: files exist on main, but are not promoted to the recommended root stable lists. The initial 20261011.1 candidate had 93 ad rules, 38 privacy rules and 13 Strict rules. Amazon's broad advertising domain was removed after exception review; New Relic and Sentry remain Strict-only.

Proposed 20261030.1 privacy-only update (Draft PR, not live): 41 privacy rules, adding only `match.prod.bidr.io`, `sync.adkernel.com` and `sync.richaudience.com` as third-party cookie/ID-sync endpoint filters. Evidence: named-host references in tracker/blocklist datasets; no new parent-domain block. Root stable, v2 ads, v2 Strict and subscriber URLs do not change. Historical full-profile review remains 2026-10-11; the three-rule delta was reviewed on 2026-10-30. No real-browser or production-site breakage verification is claimed.

Pinned upstream references and actual uBO/Ghostery engines were checked. Public-page network smoke checks and synthetic DOM tests do not establish login, form or video-playback compatibility. v2 is not automatically promoted over the root stable lists.
