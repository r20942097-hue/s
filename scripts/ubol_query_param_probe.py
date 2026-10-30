"""Read-only stock uBO Lite URL query tracking-parameter compatibility probe.

Runs real official, SHA256-pinned uBO Lite in an ephemeral Chromium profile;
asks Chrome's testMatchOutcome about SYNTHETIC navigation/subrequest URLs.
Neither fetches those URLs nor claims that query parameters are removed.
No new filter is generated, published or loaded.
"""
import argparse
import json
from pathlib import Path
import tempfile
import traceback
from urllib.parse import urlencode, urlsplit, parse_qsl

from audit_filter_candidates import ROOT
from ubol_real_addon_fixture import (
    LOCK_PATH, fetch_archive, extract_verified,
    validate_runtime_identity, resolve_official_rule_actions
)

TRACKING = ("utm_source", "utm_campaign", "fbclid", "gclid", "msclkid")
PRESERVE = ("state", "code", "token", "redirect_uri", "X-Amz-Signature")
KINDS = ("main_frame", "xmlhttprequest")
# Example Domains are intentional. No actual network request will be sent.
DESTINATIONS = {
    "main_frame": "https://example.com/landing",
    "xmlhttprequest": "https://example.net/collect"
}
LIMIT_CASES = 48


def cases():
    result = []
    for kind in KINDS:
        base = DESTINATIONS[kind]
        for key in TRACKING + PRESERVE:
            q = urlencode(((key, "synthetic-value"), ("keep", "ok")))
            url = base + "?" + q
            parsed = urlsplit(url)
            params = parse_qsl(parsed.query, keep_blank_values=True)
            if (parsed.scheme != "https" or parsed.hostname not in ("example.com", "example.net")
                    or params != [(key, "synthetic-value"), ("keep", "ok")]):
                raise ValueError("synthetic URL parameter corpus is malformed")
            result.append({
                "key": key, "class": "TRACKING_REVIEW" if key in TRACKING else "MUST_PRESERVE",
                "request_type": kind, "url": url,
                "baseline_url": base + "?keep=ok"
            })
    if len(result) != len(KINDS) * (len(TRACKING) + len(PRESERVE)):
        raise ValueError("incomplete synthetic parameter cases")
    if len(result) > LIMIT_CASES:
        raise ValueError("synthetic request cap exceeded")
    return result


def inspect_stock(extension_root, manifest, rows):
    from playwright.sync_api import sync_playwright
    with tempfile.TemporaryDirectory(prefix="ubol-param-profile-") as profile, sync_playwright() as pw:
        context = pw.chromium.launch_persistent_context(
            profile, channel="chromium", headless=True,
            args=[f"--disable-extensions-except={extension_root}",
                  f"--load-extension={extension_root}"]
        )
        try:
            workers = context.service_workers
            sw = workers[0] if workers else context.wait_for_event("serviceworker", timeout=30000)
            runtime = sw.evaluate("""async () => ({
                name: chrome.runtime.getManifest().name,
                version: chrome.runtime.getManifest().version,
                manifest_version: chrome.runtime.getManifest().manifest_version,
                enabled_ruleset_ids: await chrome.declarativeNetRequest.getEnabledRulesets()
            })""")
            validate_runtime_identity(runtime, manifest)
            observed = sw.evaluate("""async sample => {
                if (typeof chrome.declarativeNetRequest.testMatchOutcome !== 'function') {
                    return {status: 'NOT_SUPPORTED', cases: [], reason: 'no testMatchOutcome'};
                }
                const cases = [];
                for (let i = 0; i < sample.length; i++) {
                    const row = sample[i];
                    for (const phase of ['with_param', 'without_param']) {
                        const url = phase === 'with_param' ? row.url : row.baseline_url;
                        const response = await chrome.declarativeNetRequest.testMatchOutcome({
                            url,
                            initiator: 'https://referrer.example/',
                            type: row.request_type,
                            method: 'get'
                        });
                        cases.push({
                            index: i, phase, host: new URL(url).hostname,
                            request_type: row.request_type,
                            matched_rules: (response.matchedRules || []).map(rule => ({
                                ruleset_id: rule.rulesetId, rule_id: rule.ruleId,
                                action_type: 'UNKNOWN'
                            }))
                        });
                    }
                }
                return {status: 'OBSERVED', cases};
            }""", rows)
            if (observed.get("status") != "OBSERVED"
                    or len(observed.get("cases", [])) != 2 * len(rows)):
                raise ValueError("incomplete uBO Lite synthetic query parameter DNR probe")
            return resolve_official_rule_actions(extension_root, manifest, observed)
        finally:
            context.close()


def summarize(rows, observed):
    if observed.get("status") != "OBSERVED":
        raise ValueError("query parameter evidence is unavailable")
    pairs = {}
    for item in observed["cases"]:
        index, phase = item.get("index"), item.get("phase")
        if (type(index) is not int or not 0 <= index < len(rows)
                or phase not in ("with_param", "without_param")
                or (index, phase) in pairs):
            raise ValueError("duplicate or malformed synthetic query test")
        pairs[(index, phase)] = item
    if len(pairs) != len(rows) * 2:
        raise ValueError("missing synthetic query controls")
    summary = []
    for i, row in enumerate(rows):
        a, b = pairs[(i, "with_param")], pairs[(i, "without_param")]
        if (a["request_type"] != row["request_type"]
                or b["request_type"] != row["request_type"]
                or a["host"] != urlsplit(row["url"]).hostname
                or b["host"] != urlsplit(row["baseline_url"]).hostname):
            raise ValueError("query probe shape inconsistent")
        if a["unresolved_actions"] or b["unresolved_actions"]:
            verdict = "INDETERMINATE"
        elif a["block_action_count"] or b["block_action_count"]:
            verdict = "DESTINATION_BLOCKED_OR_PARTLY_BLOCKED"
        elif any(e["action_type"] == "redirect" for e in a["matched_rules"]):
            verdict = "STOCK_REDIRECT_RULE_MATCH_NOT_REMOVAL_PROOF"
        else:
            verdict = "NO_STOCK_REDIRECT_MATCH_IN_TESTED_SHAPE"
        summary.append({
            "key": row["key"], "class": row["class"],
            "request_type": row["request_type"],
            "stock_dnr_verdict": verdict,
            "matching_rule_count_with_param": len(a["matched_rules"]),
            "matching_rule_count_control": len(b["matched_rules"]),
            "actual_query_stripping": "NOT_TESTED",
            "safe_for_signed_urls": "NOT_ESTABLISHED",
            "suggest_addition": False
        })
    if len(summary) != len(rows):
        raise ValueError("query probe result count mismatch")
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    try:
        rows = cases()
        lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
        data = fetch_archive(lock)
        with tempfile.TemporaryDirectory(prefix="ubol-param-release-") as temp:
            root, manifest = extract_verified(data, lock, Path(temp) / "official-ubol")
            observed = inspect_stock(root, manifest, rows)
        findings = summarize(rows, observed)
        counts = {label: sum(r["stock_dnr_verdict"] == label for r in findings)
                  for label in (
                      "INDETERMINATE", "DESTINATION_BLOCKED_OR_PARTLY_BLOCKED",
                      "STOCK_REDIRECT_RULE_MATCH_NOT_REMOVAL_PROOF",
                      "NO_STOCK_REDIRECT_MATCH_IN_TESTED_SHAPE"
                  )}
        report = {
            "schema": "filter-stock-query-parameter-probe/v1",
            "official_extension": "uBO Lite",
            "pinned_release": lock["release_tag"],
            "pinned_sha256": lock["sha256"],
            "case_count": len(rows),
            "tracking_parameter_names": list(TRACKING),
            "sensitive_query_controls": list(PRESERVE),
            "tested_request_types": list(KINDS),
            "counts": counts, "cases": findings,
            "synthetic_only": True,
            "real_query_removal": "NOT_RUN",
            "login_checkout_compatibility": "NOT_RUN",
            "published_tracking_parameter_rules": 0,
            "incremental_value": "NOT_ESTABLISHED",
            "publication": "NO_GO"
        }
        if args.report:
            path = args.report.resolve()
            if path.is_relative_to(ROOT.resolve()):
                raise ValueError("report destination inside repository")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print("STOCK PARAMETER PROBE:", len(findings), "synthetic cases", counts,
              "; NOT a query-removal/real-site test; zero new rules")
    except Exception as exc:
        print("STOCK PARAMETER PROBE FAILED:", type(exc).__name__, str(exc))
        traceback.print_exc()
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
