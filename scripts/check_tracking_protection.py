"""Fail-closed audit that tracking protection remains active after deduplication.

Validates actual generated subscriptions against the source registry while
keeping seven stock-overlapping tracker proposals quarantined. Does not
claim live-site efficacy or silently add new rules.
"""
import argparse
import json
from pathlib import Path
import sys

from audit_filter_candidates import ROOT
from generate_lists import render, validate_profiles

POLICY_PATH = ROOT / "verification/tracking-protection-policy.json"
PROFILES_PATH = ROOT / "filter-profiles.json"
EVIDENCE_PATH = ROOT / "verification/filter-candidates.json"


def active_lines(text):
    return [line for line in text.splitlines()
            if line and not line.startswith(("!", "["))]


def audit(profiles, policy, evidence, rendered):
    errors = []
    if (not isinstance(policy, dict)
            or policy.get("schema") != "filter-tracking-protection-policy/v1"
            or policy.get("status") != "PRESERVE_TRACKING_PREVENTION"
            or policy.get("release") != "NO_GO"
            or policy.get("owner_merge") != "NEEDS_HUMAN"
            or policy.get("live_site_e2e") != "NOT_RUN"):
        errors.append("invalid or unsafe tracking-protection policy")
        return errors, {"schema": "filter-tracking-protection-check/v1", "status": "FAIL"}
    if validate_profiles(profiles):
        errors.append("source profile does not validate")
    expected = {
        "stable": ("tracking.txt", "privacy-core"),
        "candidate": ("v2/tracking.txt", "privacy-v2"),
        "quarantine": ("v2/tracking-extra.txt", "privacy-optional-20261030"),
    }
    selection = policy.get("active_scope")
    if not isinstance(selection, dict) or set(selection) != set(expected):
        errors.append("invalid active anti-tracking scopes")
        selection = {}
    outputs = {}
    for row in profiles.get("outputs", []):
        if row.get("scope") == "s":
            outputs[row.get("path")] = row
    rules = {}
    for key, (path, family) in expected.items():
        entry = selection.get(key)
        output = outputs.get(path)
        source = profiles.get("rule_sets", {}).get(family)
        if (not isinstance(entry, dict) or entry.get("path") != path
                or entry.get("rule_set") != family
                or not isinstance(output, dict)
                or output.get("rule_sets") != [family]
                or not isinstance(source, dict)
                or not isinstance(source.get("rules"), list)):
            errors.append("missing/altered tracking protection output: " + key)
            continue
        active = source["rules"]
        if key == "quarantine":
            if (active != [] or source.get("disabled") is not True
                    or entry.get("active_rule_count") != 0):
                errors.append("quarantined stock-overlap rules are active")
        elif not active:
            errors.append("tracking protection was emptied: " + key)
        if path not in rendered or active_lines(rendered[path]) != active:
            errors.append("anti-tracking generated file differs from source: " + path)
        rules[key] = active
    # Preserve every previously active rule, not only category representatives.
    # New rules may be reviewed separately; silent removal/substitution is forbidden.
    baseline = policy.get("protected_rule_baseline")
    if not isinstance(baseline, dict) or set(baseline) != {"stable", "candidate"}:
        errors.append("protected tracking rule baseline missing")
    else:
        for scope, expected_count in (("stable", 9), ("candidate", 38)):
            protected = baseline.get(scope)
            current = rules.get(scope, [])
            if (not isinstance(protected, list)
                    or len(protected) != expected_count
                    or any(not isinstance(item, str) or not item for item in protected)
                    or len(set(protected)) != expected_count):
                errors.append("protected tracking baseline invalid: " + scope)
                continue
            if len(current) != len(set(current)):
                errors.append("duplicate active tracking rules: " + scope)
            missing = sorted(set(protected) - set(current))
            if missing:
                errors.append("protected tracking rule removed: " + scope
                              + " (" + ", ".join(missing) + ")")
    families = policy.get("observed_rule_families")
    required_groups = {
        "third_party_analytics", "session_replay",
        "advertising_measurement", "tracking_beacons"
    }
    if (not isinstance(families, list)
            or {row.get("id") for row in families if isinstance(row, dict)}
            != required_groups or len(families) != len(required_groups)):
        errors.append("required tracking feature categories missing")
        families = []
    for row in families:
        if not isinstance(row, dict):
            errors.append("malformed tracking family")
            continue
        scope = row.get("scope")
        expected_scope = "core" if row.get("id") in (
            "third_party_analytics", "session_replay") else "candidate"
        if scope != expected_scope or not isinstance(row.get("required_rules"), list):
            errors.append("incorrect tracking family scope or representative rules")
            continue
        expected_rules = row["required_rules"]
        if not expected_rules or len(set(expected_rules)) != len(expected_rules):
            errors.append("missing or duplicate tracking family evidence")
        selected_rules = rules.get("stable" if scope == "core" else "candidate", [])
        if any(rule not in selected_rules for rule in expected_rules):
            errors.append("tracking family lost its active filter rules: " + str(row.get("id")))
    quarantine = evidence.get("quarantine") if isinstance(evidence, dict) else None
    if (not isinstance(quarantine, dict)
            or quarantine.get("schema") != "stock-overlap-quarantine/v1"
            or quarantine.get("quarantined_rule_count") != 7
            or quarantine.get("active_rule_count") != 0):
        errors.append("missing seven-rule stock-overlap quarantine")
    else:
        archived = quarantine.get("three_v2_rules", []) + quarantine.get("four_extra_rules", [])
        if len(archived) != 7 or len(set(archived)) != 7:
            errors.append("stock-overlap quarantine invalid")
        for name in ("stable", "candidate", "quarantine"):
            if any(rule in rules.get(name, []) for rule in archived):
                errors.append("archived stock-overlap returned to active tracking: " + name)
    admission = policy.get("candidate_rule_rules")
    expected_controls = {
        "no_unreviewed_publication",
        "require_baseline_overlap_check",
        "require_endpoint_level_justification",
        "require_negative_controls",
        "require_live_site_compatibility_before_release",
        "accept_only_established_incremental_value"
    }
    if (not isinstance(admission, dict)
            or any(admission.get(k) is not True for k in expected_controls)
            or admission.get("exclude_archived_stock_overlap_count") != 7):
        errors.append("missing anti-duplication and site-safety admission rules")
    feature_list = policy.get("additional_privacy_elements")
    feature_states = {
        "tracking_url_parameters": "RESEARCH_ONLY",
        "cname_first_party": "RESEARCH_ONLY",
        "fingerprinting_browser_apis": "RESEARCH_ONLY",
        "gpc_header": "BROWSER_SETTING_NOT_FILTER_RULE"
    }
    if (not isinstance(feature_list, list)
            or len(feature_list) != len(feature_states)
            or {x.get("id"): x.get("state") for x in feature_list if isinstance(x, dict)}
            != feature_states):
        errors.append("unsupported or misreported supplemental privacy features")
    result = {
        "schema": "filter-tracking-protection-check/v1",
        "status": "FAIL" if errors else "PASS",
        "tracking_core_rule_count": len(rules.get("stable", [])),
        "tracking_v2_rule_count": len(rules.get("candidate", [])),
        "active_experimental_rule_count": len(rules.get("quarantine", [])),
        "protected_feature_families": len(required_groups) if not errors else None,
        "stock_overlaps_quarantined": 7 if not errors else None,
        "tracking_url_parameter_stripping": "NOT_IMPLEMENTED_BY_THIS_LIST",
        "live_site_e2e": "NOT_RUN",
        "publication": "NO_GO",
        "errors": errors
    }
    return errors, result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    try:
        profiles = json.loads(PROFILES_PATH.read_text(encoding="utf-8"))
        policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
        evidence = json.loads(EVIDENCE_PATH.read_text(encoding="utf-8"))
        rendered = {}
        for output in profiles["outputs"]:
            if output.get("scope") == "s" and output.get("path") in (
                "tracking.txt", "v2/tracking.txt", "v2/tracking-extra.txt"):
                path = ROOT / output["path"]
                rendered[output["path"]] = path.read_text(encoding="utf-8")
                if render(profiles, output) != rendered[output["path"]]:
                    raise ValueError("generated tracking output is stale: " + output["path"])
        errors, report = audit(profiles, policy, evidence, rendered)
        if args.report:
            target = args.report.resolve()
            if target.is_relative_to(ROOT.resolve()):
                raise ValueError("CI report must be outside source checkout")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print("TRACKING PROTECTION:", report["status"],
              "stable", report["tracking_core_rule_count"],
              "v2", report["tracking_v2_rule_count"],
              "retired stock-duplicate", 7,
              "live-site", report["live_site_e2e"],
              "release", report["publication"])
        for error in errors:
            print("TRACKING PROTECTION ERROR:", error, file=sys.stderr)
        return int(bool(errors))
    except (OSError, ValueError, TypeError, KeyError) as exc:
        print("TRACKING PROTECTION ERROR:", exc, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
