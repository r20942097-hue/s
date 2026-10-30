"""Read-only discovery for AdGuard hosts NOT covered by stock uBO Lite rules.

This checks a bounded, deterministic sample of the pinned AdGuard tracking
source against actual DNR rules in the unmodified SHA256-pinned official uBOL
Chromium extension. It does NOT import or promote any host to a subscription.
"""
import argparse
import json
from pathlib import Path
import tempfile
import traceback

from audit_filter_candidates import ROOT, fetch_pinned, read_json
from independent_baseline import fetch_baselines
from scan_upstream_delta import scan
from ubol_real_addon_fixture import (
    LOCK_PATH, fetch_archive, extract_verified,
    validate_runtime_identity, resolve_official_rule_actions
)

REQUEST_TYPES = ("image", "script", "xmlhttprequest")
MAX_PROBE = 120


def shortlist(profiles, evidence, tracking, allowlist, baselines, limit):
    if type(limit) is not int or limit < 1 or limit > MAX_PROBE:
        raise ValueError("probe sample cap exceeded")
    report = scan(profiles, evidence, tracking, allowlist, limit=200,
                  baseline_sources=baselines, offset=0)
    # Scanner sorts unexplained/non-exception targets first. Still require
    # explicit checks here, since its ordering is not a safety guarantee.
    filtered = []
    for item in report["queue"]:
        if (item["coverage"] != "not-covered"
                or item["selected_independent_easyprivacy_reference"] is not None
                or item["selected_allowlist_references"]
                or item["selected_allowlist_exception_lines"]
                or item["risk_flags"]):
            continue
        filtered.append(item)
        if len(filtered) == limit:
            break
    if len(filtered) < limit and report["next_offset"] is not None:
        # Never claim an exhaustive scan from a bounded page; fail rather than
        # silently promote a partial sample.
        pass
    return filtered, report["queue_total"]


def inspect_live_stock(extension_root, manifest, hosts):
    """Use browser's real MV3 DNR test API; hypothetical only."""
    from playwright.sync_api import sync_playwright
    with tempfile.TemporaryDirectory(prefix="filter-gap-profile-") as profile, sync_playwright() as pw:
        context = pw.chromium.launch_persistent_context(
            profile, channel="chromium", headless=True,
            args=[f"--disable-extensions-except={extension_root}",
                  f"--load-extension={extension_root}"]
        )
        try:
            workers = context.service_workers
            sw = workers[0] if workers else context.wait_for_event("serviceworker", timeout=30000)
            meta = sw.evaluate("""async () => ({
                name: chrome.runtime.getManifest().name,
                version: chrome.runtime.getManifest().version,
                manifest_version: chrome.runtime.getManifest().manifest_version,
                enabled_ruleset_ids: await chrome.declarativeNetRequest.getEnabledRulesets()
            })""")
            validate_runtime_identity(meta, manifest)
            observed = sw.evaluate("""async data => {
                if (typeof chrome.declarativeNetRequest.testMatchOutcome !== 'function') {
                    return {status: 'NOT_SUPPORTED', cases: []};
                }
                const cases = [];
                for (const host of data.hosts) {
                    for (const type of data.types) {
                        const suffix = type === 'script' ? 'tracker.js' :
                            type === 'xmlhttprequest' ? 'collect' : 'pixel.gif';
                        const reply = await chrome.declarativeNetRequest.testMatchOutcome({
                            url: 'https://' + host + '/' + suffix,
                            initiator: 'https://review-fixture.example/',
                            type, method: 'get'
                        });
                        cases.push({
                            host, request_type: type,
                            matched_rules: (reply.matchedRules || []).map(rule => ({
                                rule_id: rule.ruleId, ruleset_id: rule.rulesetId,
                                action_type: 'UNKNOWN'
                            }))
                        });
                    }
                }
                return {status: 'OBSERVED', cases};
            }""", {"hosts": hosts, "types": list(REQUEST_TYPES)})
            if observed["status"] != "OBSERVED" or len(observed["cases"]) != len(hosts) * len(REQUEST_TYPES):
                raise ValueError("cannot complete all hypothetical DNR requests")
            observed = resolve_official_rule_actions(extension_root, manifest, observed)
            return {"rulesets": meta["enabled_ruleset_ids"], "observed": observed}
        finally:
            context.close()


def categorize(choices, observed):
    cases = observed["cases"]
    if len(cases) != len(choices) * len(REQUEST_TYPES):
        raise ValueError("incomplete DNR probe sample")
    grouped = {}
    for case in cases:
        host = case["host"]
        if host not in {r["host"] for r in choices} or case["request_type"] not in REQUEST_TYPES:
            raise ValueError("unrecognized DNR case")
        grouped.setdefault(host, {})[case["request_type"]] = case
    result = []
    for item in choices:
        host = item["host"]
        by_type = grouped.get(host)
        if by_type is None or set(by_type) != set(REQUEST_TYPES):
            raise ValueError("missing type/host coverage")
        if any(row["unresolved_actions"] for row in by_type.values()):
            classification = "UNRESOLVED"
        elif all(row["block_action_count"] == 0 for row in by_type.values()):
            classification = "NO_STOCK_BLOCK_MATCH_IN_TESTED_SHAPES"
        else:
            classification = "STOCK_BLOCKED_IN_TESTED_SHAPES"
        result.append({
            "host": host, "source_url": item["source_url"],
            "source_line": item["line"],
            "classification": classification,
            "request_type_results": {
                kind: {
                    "matched": len(by_type[kind]["matched_rules"]),
                    "block_actions": by_type[kind]["block_action_count"],
                    "unresolved": by_type[kind]["unresolved_actions"]
                } for kind in REQUEST_TYPES
            },
            "incremental_value": "NOT_ESTABLISHED",
            "site_breakage": "NOT_RUN",
            "proposed_for_publication": False
        })
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=80)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    try:
        profiles = read_json(ROOT / "filter-profiles.json")
        evidence = read_json(ROOT / "verification/filter-candidates.json")
        sources = {key: fetch_pinned(source).decode("utf-8-sig")
                   for key, source in evidence["sources"].items()}
        independent = fetch_baselines(
            read_json(ROOT / "verification/filter-independent-baselines.json"))
        selected, universe = shortlist(profiles, evidence, sources["tracking"],
                                       sources["allowlist"], independent, args.limit)
        if not selected:
            raise ValueError("no review items remain in selected pinned snapshot page")
        lock = read_json(LOCK_PATH)
        archive = fetch_archive(lock)
        with tempfile.TemporaryDirectory(prefix="filter-stock-gap-") as temp:
            root, manifest = extract_verified(archive, lock, Path(temp) / "official-ubol")
            outcome = inspect_live_stock(root, manifest, [c["host"] for c in selected])
        rows = categorize(selected, outcome["observed"])
        counts = {status: sum(row["classification"] == status for row in rows)
                  for status in (
                    "STOCK_BLOCKED_IN_TESTED_SHAPES",
                    "NO_STOCK_BLOCK_MATCH_IN_TESTED_SHAPES", "UNRESOLVED"
                  )}
        report = {
            "schema": "filter-stock-gap-sample/v1",
            "source_commit": evidence["sources"]["tracking"]["commit"],
            "official_ubol_release": lock["release_tag"],
            "official_ubol_sha256": lock["sha256"],
            "source_review_universe": universe,
            "selected_page_only": True,
            "selected_sample_count": len(selected),
            "request_types": list(REQUEST_TYPES),
            "classification_counts": counts,
            "items": rows,
            "publication": "NO_GO",
            "automatic_adoption": False,
            "site_compatibility": "NOT_RUN",
            "actual_http_requests": "NOT_RUN",
            "limitations": [
                "Only first sorted pinned upstream review page sampled, not exhaustive.",
                "Only three representative third-party request types tested.",
                "Selected EasyPrivacy files, not all blocker filter lists, were pre-screened.",
                "Unmatched synthetic DNR requests do not establish novelty or safety.",
                "No candidate list, GitHub main or subscription output is modified."
            ]
        }
        if args.report:
            target = args.report.resolve()
            if target.is_relative_to(ROOT.resolve()):
                raise ValueError("report must be outside checkout")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print("STOCK GAP REVIEW: selected", len(selected),
              "from", universe, "upstream review hosts", counts,
              "; NO_GO; 3p hypothetical only")
        for item in rows:
            if item["classification"] == "NO_STOCK_BLOCK_MATCH_IN_TESTED_SHAPES":
                print("GAP REVIEW ONLY:", item["host"], item["source_url"])
    except Exception as exc:
        print("STOCK GAP REVIEW FAILED:", type(exc).__name__, str(exc))
        traceback.print_exc()
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
