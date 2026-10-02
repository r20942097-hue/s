# Filter v2 global candidate

This directory contains the global next-generation candidate set. The root `ad.txt` and `tracking.txt` remain unchanged while v2 is evaluated.

## Scope

v2 is no longer Japan-focused. It combines a compact global supplement for widely used advertising and tracking infrastructure with selected regional rules. Japanese rules remain included as one regional subset.

Upstream projects reviewed on 2026-10-02:
- EasyList / EasyPrivacy
- AdGuard Base, Tracking Protection, and regional filters
- uBlock Origin uAssets

## Overlap reduction (2026-10-02)

A narrow static pass compared these candidates with the selected EasyList and EasyPrivacy subscriptions in the user's uBO backup. It removed 43 broad host rules from `ad.txt`, 27 from `tracking.txt`, and 1 from `strict.txt` where an upstream list already had an unrestricted host-anchored blocking rule. The remaining lists contain 51, 13, and 10 network rules respectively. Removed rules and source snapshot hashes are recorded in `evidence/overlap-audit-20261002.json`.

This pass did not treat resource-limited, path-based, or site-specific upstream rules as full duplicates. It also did not prune against AdGuard, HaGeZi, or the user's existing root `ad.txt` and `tracking.txt`. Since those are also selected in the current profile, v2 remains a candidate and needs those overlaps reviewed before subscription; it has not been installed or promoted.

## Automatic review

When this directory is installed in the `r20942097-hue/s` repository, `.github/workflows/weekly-filter-overlap-review.yml` runs a static EasyList/EasyPrivacy overlap audit weekly and on manual dispatch. If it changes candidate rules or evidence, it opens a review PR; it never adds rules or publishes directly to the stable root lists. Browser regression and canary review are still required.

Separately, uBO refreshes subscribed lists automatically when “Auto update filter lists” is enabled. Each candidate declares `Expires: 5 days`; this controls when the list becomes eligible for refresh, not when the GitHub-hosted list's contents change. See `TESTING.md` for what this workflow does and does not validate.

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
- `popads.net` is omitted from this candidate because the target configuration already subscribes to Yhonay AntiPopAds.
- Broad host duplicates found in the selected EasyList and EasyPrivacy snapshots are omitted; see the overlap audit for its scope and limits.

## Subscription URLs

- https://raw.githubusercontent.com/r20942097-hue/s/main/v2/ad.txt
- https://raw.githubusercontent.com/r20942097-hue/s/main/v2/tracking.txt
- https://raw.githubusercontent.com/r20942097-hue/s/main/v2/strict.txt

## Static checks

Run these from the repository root:

```sh
python -m unittest discover -s v2/scripts -p 'test_*.py'
python v2/scripts/validate_filters.py
```

These checks verify declared metadata and policy only. They do not establish real-site effectiveness or safety. The promotion gate is separate and remains blocked until evidence exists:

```sh
python v2/scripts/validate_promotion.py --target canary --evidence evidence/current.json
```

See `TESTING.md` before considering promotion.

## Status

Candidate. Public retrieval is verified. The narrow EasyList/EasyPrivacy overlap pass was reviewed on 2026-10-02. Full overlap review against the active AdGuard and HaGeZi lists and root custom lists, plus real-site regression testing, is required before subscribing to or promoting v2.
