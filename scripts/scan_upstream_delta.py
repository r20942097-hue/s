"""Read-only candidate discovery from verified pinned upstream snapshots.

Produces a *review queue*, not filters. No rule adoption, list writes or push.
"""
import argparse
import json
from pathlib import Path
import re
import sys

from audit_filter_candidates import ROOT, fetch_pinned, read_json
from generate_lists import valid_hostname

RULE = re.compile(r"\|\|([a-z0-9.-]+)\^\$third-party\Z")
ANY_RULE = re.compile(r"\|\|([a-z0-9.-]+)(?:\^|/)")
HOST_BOUNDARY = r"(?<![A-Za-z0-9_.-]){}(?![A-Za-z0-9_.-])"


def filter_hosts(profiles):
    hosts = set()
    for rule_set in profiles["rule_sets"].values():
        for rule in rule_set["rules"]:
            m = ANY_RULE.match(rule)
            if m is not None:
                hosts.add(m.group(1))
    return hosts


def overlapping(host, existing):
    return any(host == prior or host.endswith("." + prior)
               or prior.endswith("." + host) for prior in existing)


def scan(profiles, evidence, tracking_text, allowlist_text, limit=40):
    if not isinstance(limit, int) or limit < 1 or limit > 200:
        raise ValueError("review queue limit must be 1..200")
    if not isinstance(tracking_text, str) or not isinstance(allowlist_text, str):
        raise ValueError("upstream snapshots must decode as text")
    source = evidence["sources"]["tracking"]
    existing = filter_hosts(profiles)
    allowlist_lines = allowlist_text.splitlines()
    reviewed = set()
    queue = []
    exact_third_party = 0
    overlapped = 0
    with_exceptions = 0
    for line_no, line in enumerate(tracking_text.splitlines(), 1):
        m = RULE.fullmatch(line.strip())
        if m is None:
            continue
        exact_third_party += 1
        host = m.group(1)
        if not valid_hostname(host) or host in reviewed:
            continue
        reviewed.add(host)
        if overlapping(host, existing):
            overlapped += 1
            continue
        pattern = re.compile(HOST_BOUNDARY.format(re.escape(host)), re.I)
        exceptions = [i for i, candidate_line in enumerate(allowlist_lines, 1)
                      if pattern.search(candidate_line)]
        if exceptions:
            with_exceptions += 1
        queue.append({"host": host, "rule": line.strip(), "line": line_no,
                      "source_url": ("https://github.com/" + source["repository"] + "/blob/"
                                     + source["commit"] + "/" + source["path"] + "#L" + str(line_no)),
                      "selected_allowlist_references": exceptions[:10],
                      "needs_manual_review": True,
                      "status": "REVIEW_REQUIRED",
                      "live_site_e2e": "NOT_RUN"})
    queue.sort(key=lambda item: (bool(item["selected_allowlist_references"]), item["host"]))
    return {"schema": "upstream-delta-review/v1",
            "source_commit": source["commit"],
            "source_blob_sha": source["git_blob_sha"],
            "upstream_exact_third_party_rules": exact_third_party,
            "already_covered_or_parent_overlap": overlapped,
            "new_candidate_hosts": len(queue),
            "candidate_hosts_with_selected_allowlist_reference": with_exceptions,
            "queue_limit": limit, "queue": queue[:limit],
            "note": "Classification is not safety or incremental efficacy. No automatic adoption.",
            "publication": "NO_GO", "live_site_e2e": "NOT_RUN"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fetch-upstream", action="store_true",
                        help="fetch exact pinned Git blobs, never moving upstream HEAD")
    parser.add_argument("--tracking-file", type=Path, help="offline snapshot input")
    parser.add_argument("--allowlist-file", type=Path, help="offline selected exception input")
    parser.add_argument("--report", type=Path, help="write JSON outside the repository only")
    parser.add_argument("--limit", type=int, default=40)
    args = parser.parse_args()
    try:
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
        report = scan(profiles, evidence, tracking, allowlist, args.limit)
        if args.report:
            target = args.report.resolve()
            if target.is_relative_to(ROOT.resolve()):
                raise ValueError("report must be outside the tracked repository")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except (OSError, ValueError, KeyError, UnicodeError, TypeError) as error:
        print("DELTA SCAN FAILED:", error, file=sys.stderr)
        return 1
    print("DELTA SCAN READ_ONLY:", report["new_candidate_hosts"], "unreviewed hosts;",
          report["candidate_hosts_with_selected_allowlist_reference"],
          "literal allowlist overlaps; review queue:", len(report["queue"]),
          "; NO_GO for auto-promotion")
    if not args.report:
        print(json.dumps(report["queue"][:min(10, args.limit)], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
