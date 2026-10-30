"""Compare per-subscription coverage without treating optional lists as installed.

Read-only; analyses only exact pinned upstream sources. A counted rule shape is
not proof of filtering behavior on live sites or within a user's extensions.
"""
import argparse
import re
import json
from pathlib import Path
import sys

from audit_filter_candidates import ROOT, fetch_pinned, read_json
from independent_baseline import fetch_baselines, observed_network_hosts, observed_scope
from scan_upstream_delta import scan, filter_hosts

OUTPUT_GROUPS = {
    "stable_combined": ("ad.txt", "tracking.txt"),
    "v2_balanced": ("v2/ad.txt", "v2/tracking.txt"),
}
REPORT_SCHEMA = "filter-subscription-coverage/v1"
V2_PROPOSED_RULES = (
    "||match.prod.bidr.io^$third-party",
    "||sync.adkernel.com^$third-party",
    "||sync.richaudience.com^$third-party"
)
THIRD_PARTY_HOST = re.compile(r"\|\|([a-z0-9.-]+)\^\$third-party\Z")


def proposed_candidate_rows(profiles, baselines, evidence):
    """Audit seven RETIRED redundant rules; none may remain in active outputs.

    Selected EasyPrivacy matches here are literal request-host/parent-rule
    *shape* comparisons; absence does not establish incremental ad blocking.
    """
    archive = evidence.get("quarantine", {})
    extra = archive.get("four_extra_rules")
    if (archive.get("schema") != "stock-overlap-quarantine/v1"
            or set(archive.get("three_v2_rules", [])) != set(V2_PROPOSED_RULES)
            or archive.get("active_rule_count") != 0
            or not isinstance(extra, list) or len(extra) != 4 or len(set(extra)) != 4):
        raise ValueError("missing or changed seven-rule stock-overlap archive")
    active = [rule for rule_set in profiles["rule_sets"].values()
              for rule in rule_set.get("rules", [])]
    if any(rule in active for rule in [*V2_PROPOSED_RULES, *extra]):
        raise ValueError("retired stock-overlap rule leaked into active subscription")
    candidates = [("v2/tracking.txt", rule) for rule in V2_PROPOSED_RULES]
    candidates += [("v2/tracking-extra.txt", rule) for rule in extra]
    reference = observed_network_hosts(baselines) if baselines is not None else None
    rows = []
    for output, rule in candidates:
        match = THIRD_PARTY_HOST.fullmatch(rule)
        if match is None:
            raise ValueError("unexpected unscoped candidate rule")
        host = match.group(1)
        found = observed_scope(host, reference) if reference is not None else None
        rows.append({
            "output": output, "host": host, "rule": rule,
            "selected_easyprivacy_reference": found["path"] if found else None,
            "selected_easyprivacy_match_shape": found["scope"] if found else None,
            "selected_easyprivacy_matching_host": found["matched_host"] if found else None,
            "incremental_blocking_value": "NOT_ESTABLISHED",
            "stock_ubol_block_action_tested": True,
            "status": "RETIRED_STOCK_OVERLAP",
            "active_rule": False,
            "real_site_compatibility": "NOT_RUN",
            "adopted_to_stable": False
        })
    if len({r["host"] for r in rows}) != 7:
        raise ValueError("duplicate across proposed candidate sets")
    return rows


def matching_sets(profiles, paths):
    if not isinstance(paths, (tuple, list)) or not paths:
        raise ValueError("expected nonempty output selection")
    outputs = [entry for entry in profiles["outputs"] if entry["scope"] == "s"]
    known = {entry["path"]: entry for entry in outputs}
    if len(paths) != len(set(paths)) or any(path not in known for path in paths):
        raise ValueError("invalid, missing or duplicated s output")
    keys = []
    for path in paths:
        for rule_set in known[path]["rule_sets"]:
            if rule_set not in keys:
                keys.append(rule_set)
    return keys


def analyze(profiles, evidence, tracking, allowlist, baselines=None):
    if not isinstance(profiles, dict) or not isinstance(profiles.get("outputs"), list):
        raise ValueError("invalid profile registry")
    if not isinstance(evidence, dict) or not isinstance(evidence.get("sources"), dict):
        raise ValueError("invalid provenance")
    available = [entry["path"] for entry in profiles["outputs"]
                 if entry.get("scope") == "s"]
    if not available or len(available) != len(set(available)):
        raise ValueError("missing or duplicate subscription paths")
    selections = {path: (path,) for path in available}
    for key, members in OUTPUT_GROUPS.items():
        if not all(member in available for member in members):
            raise ValueError("required stable/v2 output missing")
        selections[key] = members
    rows = []
    total = None
    for key, paths in selections.items():
        keys = matching_sets(profiles, paths)
        subset = {"rule_sets": {name: profiles["rule_sets"][name] for name in keys}}
        # Use the same pinned tracking and allowlist bytes for all scopes.
        result = scan(subset, evidence, tracking, allowlist, limit=1,
                      baseline_sources=baselines)
        subtotal = result["already_covered_by_local_parent_or_exact"] + result["new_candidate_hosts"]
        if total is not None and total != subtotal:
            raise ValueError("inconsistent scanned host universe between subscriptions")
        total = subtotal
        scope = filter_hosts(subset)
        rows.append({
            "name": key,
            "outputs": list(paths),
            "source_rule_sets": keys,
            "full_host_rules": len(scope["full"]),
            "restricted_local_rules": len(scope["restricted"]),
            "upstream_unique_candidate_universe": subtotal,
            "covered_by_exact_or_parent": result["already_covered_by_local_parent_or_exact"],
            "not_covered_by_exact_or_parent": result["new_candidate_hosts"],
            "possible_allowlist_exception_targets": result["candidate_hosts_with_selected_allowlist_exception"],
            "selected_easyprivacy_overlap_among_not_covered":
                result["candidate_hosts_also_observed_in_selected_easyprivacy"]
        })
    candidate_rows = proposed_candidate_rows(profiles, baselines, evidence)
    return {
        "schema": REPORT_SCHEMA,
        "pinned_tracking_commit": evidence["sources"]["tracking"]["commit"],
        "source_host_universe": total,
        "independent_comparison": "PASS" if baselines is not None else "NOT_RUN",
        "outputs": rows,
        "proposed_candidate_count": 0,
        "retired_stock_overlap_count": len(candidate_rows),
        "proposed_candidate_evidence": candidate_rows,
        "publication": "NO_GO",
        "live_site_e2e": "NOT_RUN",
        "limitations": [
            "Counts are for selected source rule-set memberships, not actual extension subscriptions.",
            "Neither uBO network exceptions nor runtime engine matching are simulated.",
            "Baseline comparisons use two pinned EasyPrivacy tracking files only.",
            "No blocking effectiveness or breakage on live sites has been tested."
        ]
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--crosscheck-independent", action="store_true",
                        help="also verify immutable EasyPrivacy sources (adopt none)")
    parser.add_argument("--report", type=Path, help="write report outside checked-out repository")
    args = parser.parse_args()
    try:
        profiles = read_json(ROOT / "filter-profiles.json")
        evidence = read_json(ROOT / "verification/filter-candidates.json")
        snapshots = {key: fetch_pinned(value).decode("utf-8-sig")
                     for key, value in evidence["sources"].items()}
        baselines = None
        if args.crosscheck_independent:
            info = read_json(ROOT / "verification/filter-independent-baselines.json")
            baselines = fetch_baselines(info)
        report = analyze(profiles, evidence, snapshots["tracking"], snapshots["allowlist"],
                         baselines=baselines)
        output = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
        if args.report:
            target = args.report.resolve()
            if target.is_relative_to(ROOT.resolve()):
                raise ValueError("report must be written outside repository")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(output, encoding="utf-8")
        else:
            print(output)
    except (OSError, ValueError, TypeError, KeyError, UnicodeError) as error:
        print("SUBSCRIPTION COVERAGE FAILED:", error, file=sys.stderr)
        return 1
    print("SUBSCRIPTION COVERAGE READ_ONLY:", len(report["outputs"]),
          "subscription/group scopes;", report["source_host_universe"],
          "source hosts; NO_GO for auto adoption", file=sys.stderr)
    for candidate in report["proposed_candidate_evidence"]:
        print("PROPOSED CANDIDATE:", candidate["host"],
              "selected EasyPrivacy:", candidate["selected_easyprivacy_match_shape"] or "NO_SELECTED_MATCH",
              "matched via:", candidate["selected_easyprivacy_matching_host"],
              "; incremental effect NOT_ESTABLISHED", file=sys.stderr)
    for item in report["outputs"]:
        print("SUBSCRIPTION SCOPE:", item["name"],
              "matched", item["covered_by_exact_or_parent"],
              "unmatched", item["not_covered_by_exact_or_parent"],
              "selected EasyPrivacy overlap",
              item["selected_easyprivacy_overlap_among_not_covered"],
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
