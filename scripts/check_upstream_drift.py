"""Read-only upstream freshness monitor. No rule updates or automatic adoption.

Compares exact pinned Git blob hashes against current public branch snapshots.
This is a diagnostic of source drift, NOT verification of candidate safety.
"""
import argparse
import json
from pathlib import Path
import re
import sys
from urllib.request import Request, urlopen

from audit_filter_candidates import ROOT, read_json, valid_source, git_blob_sha
from independent_baseline import validate_baselines

SHA40 = re.compile(r"[0-9a-f]{40}\Z")
BRANCHES = {"AdguardTeam/AdguardFilters": "master", "easylist/easylist": "master"}
MAX_BYTES = 4_000_000


def sources_to_check(candidate, independent):
    sources = candidate.get("sources", {})
    if set(sources) != {"tracking", "allowlist"} or not all(valid_source(s) for s in sources.values()):
        raise ValueError("missing or invalid tracking/allowlist source pins")
    validate_baselines(independent)
    result = [sources["tracking"], sources["allowlist"]] + independent["sources"]
    keys = [(row["repository"], row["path"]) for row in result]
    if len(keys) != len(set(keys)):
        raise ValueError("duplicate upstream path in source pins")
    return result


def fetch_json(uri):
    with urlopen(Request(uri, headers={"User-Agent": "filter-source-freshness/1",
                                      "Accept": "application/vnd.github+json"}), timeout=30) as response:
        data = response.read(200_001)
    if len(data) > 200_000:
        raise ValueError("branch metadata oversized")
    return json.loads(data)


def fetch_bytes(uri):
    with urlopen(Request(uri, headers={"User-Agent": "filter-source-freshness/1"}), timeout=30) as response:
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("current upstream source oversized")
    return data


def assess_sources(candidate, independent, branch_lookup=None, blob_lookup=None):
    rows = sources_to_check(candidate, independent)
    branches = {}
    output = []
    for source in rows:
        repository = source["repository"]
        if repository not in BRANCHES:
            raise ValueError("unapproved upstream repository")
        if repository not in branches:
            if branch_lookup is None:
                branch = BRANCHES[repository]
                info = fetch_json(f"https://api.github.com/repos/{repository}/branches/{branch}")
                sha = info.get("commit", {}).get("sha")
            else:
                sha = branch_lookup(repository, BRANCHES[repository])
            if not isinstance(sha, str) or not SHA40.fullmatch(sha):
                raise ValueError("invalid upstream branch head")
            branches[repository] = sha
        head = branches[repository]
        uri = f'https://raw.githubusercontent.com/{repository}/{head}/{source["path"]}'
        data = fetch_bytes(uri) if blob_lookup is None else blob_lookup(uri)
        if not isinstance(data, bytes) or len(data) > MAX_BYTES:
            raise ValueError("invalid upstream content bytes")
        digest = git_blob_sha(data)
        status = "UNCHANGED_CONTENT" if digest == source["git_blob_sha"] else "DRIFT_OBSERVED"
        output.append({
            "repository": repository, "path": source["path"],
            "pinned_commit": source["commit"], "current_branch": BRANCHES[repository],
            "observed_head": head, "pinned_blob": source["git_blob_sha"],
            "observed_blob": digest, "status": status, "rule_adoption": "FORBIDDEN"
        })
    drift = sum(r["status"] == "DRIFT_OBSERVED" for r in output)
    return {
        "schema": "filter-upstream-drift/v1",
        "sources_checked": len(output), "drift_files": drift,
        "up_to_date_contents": len(output)-drift,
        "publication": "NO_GO",
        "automatic_source_pin_update": False,
        "live_site_e2e": "NOT_RUN",
        "note": "Pinned files remain immutable even if upstream content changes. A drift requires independent review, not automatic pin or rule promotion.",
        "files": output
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, help="save JSON outside repository")
    args = parser.parse_args()
    try:
        candidate = read_json(ROOT / "verification/filter-candidates.json")
        independent = read_json(ROOT / "verification/filter-independent-baselines.json")
        report = assess_sources(candidate, independent)
        if args.report:
            dest = args.report.resolve()
            if dest.is_relative_to(ROOT.resolve()):
                raise ValueError("reports may not modify tracked repository files")
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except (OSError, ValueError, KeyError, TypeError, UnicodeError) as error:
        print("UPSTREAM FRESHNESS UNKNOWN:", error, file=sys.stderr)
        return 2
    print("UPSTREAM FRESHNESS REPORT:", report["sources_checked"], "files checked;",
          report["drift_files"], "content changes; NO automatic adoption")
    if not args.report:
        print(json.dumps(report["files"], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
