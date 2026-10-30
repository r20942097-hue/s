"""Bounded read-only upstream review: never import candidates into live filters.

All classification comes from immutable pinned snapshots. "Novel" means only
not present in our local profile registry, NOT new to ecosystem filtering.
"""
import argparse
from collections import defaultdict
import json
from pathlib import Path
import re
import sys

from audit_filter_candidates import ROOT, fetch_pinned, read_json
from generate_lists import valid_hostname
from independent_baseline import fetch_baselines, observed_network_hosts, observed_reference

RULE = re.compile(r"\|\|([a-z0-9.-]+)\^\$third-party\Z")
ANY_RULE = re.compile(r"\|\|([a-z0-9.-]+)(?:\^|/)")
# Conservative literal-host tokens; regex-escaped and wildcard references are NOT
# decoded and must remain outside the claims of this limited allowlist search.
HOST_TOKEN = re.compile(r"(?<![A-Za-z0-9_.-])([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?![A-Za-z0-9_.-])")


def filter_hosts(profiles):
    hosts = set()
    for rule_set in profiles["rule_sets"].values():
        for rule in rule_set["rules"]:
            m = ANY_RULE.match(rule)
            if m is not None:
                hosts.add(m.group(1))
    return hosts


def coverage(host, existing):
    """Return exact/ancestor coverage before detecting riskier parent expansion."""
    parts = host.split(".")
    for index in range(len(parts) - 1):
        if ".".join(parts[index:]) in existing:
            return "covered"
    if any(value.endswith("." + host) for value in existing):
        return "expands-existing-child"
    return "not-covered"


def allowlist_index(text):
    """Single-pass index for *literal* host appearances; never equate with safety."""
    found = defaultdict(lambda: {"mentions": [], "exception_rules": []})
    for line_no, line in enumerate(text.splitlines(), 1):
        hosts = {match.group(1).lower() for match in HOST_TOKEN.finditer(line)}
        for host in hosts:
            found[host]["mentions"].append(line_no)
            if line.lstrip().startswith("@@"):
                found[host]["exception_rules"].append(line_no)
    return found


def scan(profiles, evidence, tracking_text, allowlist_text, limit=40, baseline_sources=None):
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1 or limit > 200:
        raise ValueError("review queue limit must be an integer 1..200")
    if not isinstance(tracking_text, str) or not isinstance(allowlist_text, str):
        raise ValueError("upstream snapshots must decode as text")
    source = evidence["sources"]["tracking"]
    existing = filter_hosts(profiles)
    references = allowlist_index(allowlist_text)
    independent = observed_network_hosts(baseline_sources) if baseline_sources is not None else None
    also_seen_independently = 0
    reviewed = set()
    queue = []
    exact_third_party = 0
    covered = 0
    expanded = 0
    with_references = 0
    with_exception_rules = 0
    for line_no, line in enumerate(tracking_text.splitlines(), 1):
        m = RULE.fullmatch(line.strip())
        if m is None:
            continue
        exact_third_party += 1
        host = m.group(1)
        if not valid_hostname(host) or host in reviewed:
            continue
        reviewed.add(host)
        status = coverage(host, existing)
        if status == "covered":
            covered += 1
            continue
        if status == "expands-existing-child":
            expanded += 1
        evidence_rows = references.get(host, {"mentions": [], "exception_rules": []})
        mentions = evidence_rows["mentions"]
        exceptions = evidence_rows["exception_rules"]
        if mentions:
            with_references += 1
        if exceptions:
            with_exception_rules += 1
        baseline_reference = observed_reference(host, independent) if independent is not None else None
        if baseline_reference:
            also_seen_independently += 1
        flags = []
        if status == "expands-existing-child":
            flags.append("parent_domain_expansion")
        if baseline_reference:
            flags.append("selected_independent_easyprivacy_reference")
        if exceptions:
            flags.append("selected_allowlist_exception")
        elif mentions:
            flags.append("selected_allowlist_literal_mention")
        queue.append({
            "host": host, "rule": line.strip(), "line": line_no,
            "source_url": ("https://github.com/" + source["repository"] + "/blob/"
                           + source["commit"] + "/" + source["path"] + "#L" + str(line_no)),
            "coverage": status,
            "selected_independent_easyprivacy_reference": baseline_reference,
            "selected_allowlist_references": mentions[:10],
            "selected_allowlist_exception_lines": exceptions[:10],
            "risk_flags": flags,
            "needs_manual_review": True,
            "status": "REVIEW_REQUIRED",
            "live_site_e2e": "NOT_RUN"
        })
    # Exclude exceptional and parent-expansion cases from the first triage batch,
    # without removing them or claiming the remaining candidates are safe.
    queue.sort(key=lambda item: (
        bool(item["selected_allowlist_exception_lines"]),
        item["coverage"] == "expands-existing-child",
        bool(item["selected_allowlist_references"]),
        bool(item["selected_independent_easyprivacy_reference"]),
        item["host"]
    ))
    return {
        "schema": "upstream-delta-review/v2",
        "source_commit": source["commit"],
        "source_blob_sha": source["git_blob_sha"],
        "upstream_exact_third_party_rules": exact_third_party,
        "already_covered_by_local_parent_or_exact": covered,
        "parent_expansion_candidates": expanded,
        "new_candidate_hosts": len(queue),
        "candidate_hosts_with_selected_allowlist_reference": with_references,
        "candidate_hosts_with_selected_allowlist_exception": with_exception_rules,
        "candidate_hosts_without_selected_allowlist_literal_reference": len(queue)-with_references,
        "selected_independent_easyprivacy_comparison": "PASS" if independent is not None else "NOT_RUN",
        "candidate_hosts_also_observed_in_selected_easyprivacy": also_seen_independently if independent is not None else None,
        "candidate_hosts_not_observed_in_selected_easyprivacy": len(queue)-also_seen_independently if independent is not None else None,
        "queue_limit": limit,
        "queue": queue[:limit],
        "limitations": [
            "Local-only coverage: not equivalent to installed EasyList, EasyPrivacy or AdGuard even when independent cross-check is enabled.",
            "Literal-host allowlist scan: regex-escaped, wildcard and semantic exceptions are not evaluated.",
            "Not all network filter options or first-party/CNAME behaviors are analyzed.",
            "Independent cross-check only reads two named EasyPrivacy source files. Excludes other EasyPrivacy rules and other blocker configurations.",
            "No real-browser or production-site tests."
        ],
        "publication": "NO_GO",
        "live_site_e2e": "NOT_RUN"
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fetch-upstream", action="store_true",
                        help="fetch immutable verified source/allowlist, never moving HEAD")
    parser.add_argument("--tracking-file", type=Path, help="offline snapshot input")
    parser.add_argument("--allowlist-file", type=Path, help="offline selected exception input")
    parser.add_argument("--report", type=Path, help="write JSON outside the repository only")
    parser.add_argument("--limit", type=int, default=40)
    parser.add_argument("--crosscheck-independent", action="store_true",
                        help="also fetch two immutable, independently pinned EasyPrivacy files; never imports rules")
    args = parser.parse_args()
    try:
        if args.crosscheck_independent and not args.fetch_upstream:
            raise ValueError("--crosscheck-independent requires --fetch-upstream for verified source provenance")
        profiles = read_json(ROOT / "filter-profiles.json")
        evidence = read_json(ROOT / "verification/filter-candidates.json")
        if args.fetch_upstream and (args.tracking_file or args.allowlist_file):
            raise ValueError("choose pinned network fetch OR both offline files")
        if args.fetch_upstream:
            data = {key: fetch_pinned(record) for key, record in evidence["sources"].items()}
            tracking = data["tracking"].decode("utf-8-sig")
            allowlist = data["allowlist"].decode("utf-8-sig")
        elif args.tracking_file and args.allowlist_file:
            tracking = args.tracking_file.read_text(encoding="utf-8-sig")
            allowlist = args.allowlist_file.read_text(encoding="utf-8-sig")
        else:
            raise ValueError("require --fetch-upstream or both --tracking-file and --allowlist-file")
        baselines = None
        if args.crosscheck_independent:
            baseline_info = read_json(ROOT / "verification/filter-independent-baselines.json")
            baselines = fetch_baselines(baseline_info)
        report = scan(profiles, evidence, tracking, allowlist, args.limit, baseline_sources=baselines)
        if args.report:
            target = args.report.resolve()
            if target.is_relative_to(ROOT.resolve()):
                raise ValueError("report must be outside the tracked repository")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except (OSError, ValueError, KeyError, UnicodeError, TypeError) as error:
        print("DELTA SCAN FAILED:", error, file=sys.stderr)
        return 1
    print("DELTA SCAN READ_ONLY:", report["new_candidate_hosts"], "not locally covered;",
          report["already_covered_by_local_parent_or_exact"], "covered;",
          report["parent_expansion_candidates"], "parent-expansion candidates;",
          report["candidate_hosts_with_selected_allowlist_exception"],
          "with selected allowlist exceptions;",
          "EasyPrivacy crosscheck:", report["selected_independent_easyprivacy_comparison"],
          "; selected EasyPrivacy overlap:", report["candidate_hosts_also_observed_in_selected_easyprivacy"],
          "; review queue:", len(report["queue"]),
          "; NO_GO for auto-promotion")
    if not args.report:
        print(json.dumps(report["queue"][:min(10, args.limit)], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
