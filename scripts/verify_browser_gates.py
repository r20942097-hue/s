"""Fail-closed acceptance report for *isolated* browser integration checks.

This is a CI report, not a release authorization. Tests do not navigate
production websites or install a browser extension in a user profile.
"""
import argparse
import json
from pathlib import Path
import sys


def assess(surrogate, native, stock, imported):
    failures = []
    if (surrogate.get("schema") != "filter-browser-fixture/v1"
            or surrogate.get("browser_fixture") != "PASS"
            or surrogate.get("extension_loaded") is not False
            or surrogate.get("live_site_e2e") != "NOT_RUN"):
        failures.append("synthetic Playwright browser fixture failed or overclaims real E2E")
    browsers = surrogate.get("browsers")
    if (not isinstance(browsers, list) or len(browsers) != 2
            or {b.get("engine") for b in browsers if isinstance(b, dict)}
            != {"chromium", "firefox"}
            or any(not isinstance(b, dict)
                   or b.get("real_extension") != "NOT_RUN"
                   or b.get("real_site_e2e") != "NOT_RUN"
                   or b.get("surrogate_blocked_request") != "PASS"
                   for b in browsers)):
        failures.append("missing/false two-engine isolated fixture evidence")

    if (native.get("schema") != "filter-chromium-dnr-fixture/v1"
            or native.get("real_extension_loaded") is not True
            or native.get("baseline_control") != "PASS"
            or native.get("same_site_control") != "PASS"
            or native.get("native_dnr_blocking") != "PASS"
            or native.get("login_checkout_fixture") != "PASS"
            or native.get("actual_adblock_extension") != "NOT_RUN"
            or native.get("live_site_e2e") != "NOT_RUN"
            or native.get("publication") != "NO_GO"):
        failures.append("native Chromium DNR fixture evidence invalid")

    hypot = stock.get("stock_dnr_hypothetical")
    cases = hypot.get("cases") if isinstance(hypot, dict) else None
    if (stock.get("schema") != "filter-real-ubol-ci/v1"
            or stock.get("archive_verified") is not True
            or stock.get("extension_loaded") != "PASS"
            or not isinstance(stock.get("active_rulesets"), int)
            or stock["active_rulesets"] != 6
            or not isinstance(cases, list) or len(cases) != 7
            or any(not isinstance(c, dict)
                   or c.get("block_action_count", 0) < 1
                   or c.get("unresolved_actions", 1) != 0 for c in (cases or []))
            or stock.get("candidate_subscription_e2e") != "NOT_RUN"
            or stock.get("live_site_e2e") != "NOT_RUN"
            or stock.get("real_firefox_ubo") != "NOT_RUN"
            or stock.get("publication") != "NO_GO"):
        failures.append("pinned real uBO Lite stock evidence invalid or overclaimed")

    observations = imported.get("observations")
    if (not isinstance(observations, dict)
            or imported.get("schema") != "filter-real-ubol-import-fixture/v1"
            or imported.get("real_official_extension") is not True
            or imported.get("candidate_rules_supplied") != 7
            or imported.get("fixture_only_control_rules") != 1
            or imported.get("import_compile") != "PASS"
            or observations.get("registered") is not True
            or observations.get("enabled") is not True
            or observations.get("compiled_storage_present") is not True
            or type(observations.get("accepted_filters")) is not int
            or observations["accepted_filters"] < 8
            or type(observations.get("download_requests")) is not int
            or observations["download_requests"] < 1
            or observations.get("unsubscribe_reverted") is not True
            or imported.get("actual_live_site_e2e") != "NOT_RUN"
            or imported.get("candidate_incremental_effect") != "NOT_ESTABLISHED"
            or imported.get("firefox_full_ubo") != "NOT_RUN"
            or imported.get("publication") != "NO_GO"):
        failures.append("real uBO Lite local import/rollback evidence invalid")

    if isinstance(observations, dict):
        before = observations.get("control_before")
        after = observations.get("control_after_import")
        rollback = observations.get("control_after_unsubscribe")
        if (not all(isinstance(row, dict) for row in (before, after, rollback))
                or before.get("match_count") != 0
                or after.get("block_action_count", 0) < 1
                or rollback.get("match_count") != 0):
            failures.append("imported synthetic DNR control did not change and revert")
    return failures


def render(surrogate, native, stock, imported, failures):
    observations = imported.get("observations") or {}
    return "\n".join([
        "## Isolated browser integration gates",
        "",
        f"**Automated gate: {'FAIL' if failures else 'PASS'}** — release **NO_GO / NEEDS_HUMAN**",
        "",
        "| Gate | Result |",
        "|---|---|",
        "| Isolated Chromium + Firefox synthetic page | " + str(surrogate.get("browser_fixture")) + " |",
        "| Chromium native temporary MV3 DNR control | " + str(native.get("native_dnr_blocking")) + " |",
        "| Official unchanged uBO Lite 2026.1026.1812 boots | " + str(stock.get("extension_loaded")) + " |",
        "| Stock default block-action matches (hypothetical 7 hosts) | 7 / 7 |",
        "| Official uBO Lite local list import | " + str(imported.get("import_compile")) + " |",
        "| Local isolated list accepted (7 held candidates + 1 test-only) | " + str(observations.get("accepted_filters")) + " |",
        "| Synthetic control import and removal | " + str(observations.get("unsubscribe_reverted")) + " |",
        "| Actual Firefox uBO / production site / efficacy | NOT_RUN |",
        "",
        "All imported filters are transient and unsubscribed before profile teardown. "
        "A native DNR hypothetical match is not a completed live request.",
        *([] if not failures else ["", "### CI gate failures"] + ["- " + e for e in failures]),
        ""
    ])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("surrogate", "native", "stock", "imported"):
        parser.add_argument("--" + key, type=Path, required=True)
    parser.add_argument("--github-summary", type=Path)
    args = parser.parse_args()
    try:
        reports = [json.loads(getattr(args, key).read_text(encoding="utf-8"))
                   for key in ("surrogate", "native", "stock", "imported")]
        failures = assess(*reports)
        output = render(*reports, failures)
        if args.github_summary:
            with args.github_summary.open("a", encoding="utf-8") as file:
                file.write(output)
        else:
            print(output)
    except (ValueError, TypeError, KeyError, OSError) as exc:
        print("BROWSER QUALITY GATE FAILED:", exc, file=sys.stderr)
        return 1
    for err in failures:
        print("BROWSER QUALITY GATE ERROR:", err, file=sys.stderr)
    return int(bool(failures))


if __name__ == "__main__":
    sys.exit(main())
