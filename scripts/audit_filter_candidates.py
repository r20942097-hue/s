"""Audit opt-in filter candidates and pinned upstream evidence without publishing.

Default mode validates local metadata and labels upstream byte verification NOT_RUN.
--fetch-upstream downloads immutable GitHub blobs and verifies Git blob identities
and exact source lines, including a scoped allowlist search. This is NOT browser E2E.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.request import Request, urlopen

from generate_lists import valid_hostname

ROOT = Path(__file__).resolve().parents[1]
SOURCE_REPO = "AdguardTeam/AdguardFilters"
SHA40 = re.compile(r"[a-f0-9]{40}\Z")
PATH_RE = re.compile(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*\Z")
RULE_RE = re.compile(r"\|\|([a-z0-9.-]+)\^\$third-party\Z")


def no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key: " + key)
        result[key] = value
    return result


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=no_duplicate_keys)


def pinned_url(source):
    return ("https://raw.githubusercontent.com/" + source["repository"] + "/"
            + source["commit"] + "/" + source["path"])


def valid_source(source):
    return (isinstance(source, dict)
            and source.get("repository") == SOURCE_REPO
            and isinstance(source.get("commit"), str)
            and bool(SHA40.fullmatch(source["commit"]))
            and isinstance(source.get("git_blob_sha"), str)
            and bool(SHA40.fullmatch(source["git_blob_sha"]))
            and isinstance(source.get("path"), str)
            and bool(PATH_RE.fullmatch(source["path"]))
            and source["path"] in {"SpywareFilter/sections/tracking_servers.txt",
                                   "SpywareFilter/sections/allowlist.txt"})


def git_blob_sha(content):
    prefix = b"blob " + str(len(content)).encode("ascii") + b"\x00"
    return hashlib.sha1(prefix + content).hexdigest()


def fetch_pinned(source):
    if not valid_source(source):
        raise ValueError("unsafe upstream source metadata")
    request = Request(pinned_url(source), headers={"User-Agent": "candidate-filter-audit/1"})
    with urlopen(request, timeout=30) as response:
        body = response.read(4_000_001)
    if len(body) > 4_000_000:
        raise ValueError("upstream source exceeds 4MB bound")
    if git_blob_sha(body) != source["git_blob_sha"]:
        raise ValueError("pinned upstream Git blob digest mismatch")
    return body


def overlaps(first, second):
    return (first == second or first.endswith("." + second) or second.endswith("." + first))


def audit(records, profiles, snapshots=None):
    errors = []
    result = {"record_schema": "filter-candidates/v1", "candidate_count": 0,
              "metadata": "FAIL", "upstream_snapshot": "NOT_RUN",
              "live_site_e2e": "NOT_RUN", "publication": "NEEDS_HUMAN"}
    if not isinstance(records, dict) or records.get("schema") != result["record_schema"]:
        return ["unsupported candidate evidence schema"], result
    if not isinstance(profiles, dict) or not isinstance(profiles.get("rule_sets"), dict):
        return ["invalid profile registry"], result
    if records.get("reviewed_at") != "2026-10-30":
        errors.append("review date must be the actual candidate review")
    if records.get("output") != "v2/tracking-extra.txt":
        errors.append("unexpected candidate output: stable lists must not be altered")
    governance = records.get("governance")
    if (not isinstance(governance, dict) or governance.get("auto_promote") is not False
            or governance.get("main_merge") != "NEEDS_HUMAN"
            or governance.get("live_browser_e2e") != "NOT_RUN"):
        errors.append("publication / browser safety gates missing")
    sources = records.get("sources")
    if not isinstance(sources, dict) or set(sources) != {"tracking", "allowlist"}:
        errors.append("expected pinned tracking and allowlist sources")
        sources = {}
    for key, source in sources.items():
        if not valid_source(source):
            errors.append("invalid pinned source " + key)
    if len(sources) == 2 and all(valid_source(s) for s in sources.values()):
        if sources["tracking"]["path"] != "SpywareFilter/sections/tracking_servers.txt":
            errors.append("wrong upstream tracking source")
        if sources["allowlist"]["path"] != "SpywareFilter/sections/allowlist.txt":
            errors.append("wrong upstream exception source")
        if sources["tracking"]["commit"] != sources["allowlist"]["commit"]:
            errors.append("tracking/exception sources must share one immutable commit")
    outputs = profiles.get("outputs", [])
    target = [x for x in outputs if isinstance(x, dict)
              and x.get("scope") == "s" and x.get("path") == records.get("output")]
    if len(target) != 1 or target[0].get("rule_sets") != ["privacy-optional-20261030"]:
        errors.append("candidate-only output mapping missing")
        target = []
    # Experimental rules must not be silently bundled into any other output.
    # This checks both direct rule-set usage and include references, even where
    # the generated output validation would otherwise accept the metadata.
    for other in outputs:
        if not isinstance(other, dict) or other.get("path") == records.get("output"):
            continue
        if ("privacy-optional-20261030" in other.get("rule_sets", [])
                or "tracking-extra.txt" in other.get("includes", [])
                or "v2/tracking-extra.txt" in other.get("includes", [])):
            errors.append("opt-in candidate must never be included from another output: " + str(other.get("path")))
    candidate_set = profiles["rule_sets"].get("privacy-optional-20261030")
    candidate_rules = candidate_set.get("rules", []) if isinstance(candidate_set, dict) else []
    if not isinstance(candidate_rules, list) or not isinstance(candidate_set, dict) or candidate_set.get("license") != "GPL-3.0-only":
        errors.append("invalid candidate rule set/license")
        candidate_rules = []
    candidates = records.get("candidates")
    if not isinstance(candidates, list) or len(candidates) == 0:
        errors.append("missing candidate evidence rows")
        candidates = []
    if len(candidates) != len(candidate_rules):
        errors.append("candidate evidence does not cover all candidate rules")
    seen = set()
    existing = []
    for name, rule_set in profiles["rule_sets"].items():
        if name == "privacy-optional-20261030" or not isinstance(rule_set, dict):
            continue
        for rule in rule_set.get("rules", []):
            if isinstance(rule, str):
                matched = re.match(r"\|\|([a-z0-9.-]+)(?:\^|/)", rule)
                if matched:
                    existing.append((name, matched.group(1)))
    for row in candidates:
        if not isinstance(row, dict):
            errors.append("invalid candidate row")
            continue
        host, rule = row.get("host"), row.get("rule")
        matched = RULE_RE.fullmatch(rule) if isinstance(rule, str) else None
        if (not isinstance(host, str) or not valid_hostname(host)
                or matched is None or matched.group(1) != host):
            errors.append("invalid narrowed third-party host rule")
            continue
        if host in seen:
            errors.append("duplicate evidence host " + host)
        seen.add(host)
        if rule not in candidate_rules:
            errors.append("unregistered candidate " + rule)
        if any(overlaps(host, old) for _, old in existing):
            errors.append("candidate overlaps existing filter family: " + host)
        if (row.get("status") != "candidate" or row.get("risk") not in ("low", "medium", "high")
                or row.get("live_site_e2e") != "NOT_RUN"
                or row.get("selected_allowlist") != "no_literal_reference_observed"
                or not isinstance(row.get("impact"), str) or not row["impact"].strip()):
            errors.append("risk / scope declaration missing for " + host)
        if (row.get("source") != "tracking" or row.get("exact_upstream_rule") != rule
                or not isinstance(row.get("line"), int) or isinstance(row["line"], bool)
                or row["line"] < 1):
            errors.append("invalid pinned line evidence for " + host)
    if set(candidate_rules) != {"||" + h + "^$third-party" for h in seen}:
        errors.append("candidate registry/evidence parity failure")
    held = records.get("held")
    if not isinstance(held, list) or len(held) < 1:
        errors.append("missing rejected or held candidates")
    else:
        for row in held:
            if (not isinstance(row, dict) or not isinstance(row.get("host"), str)
                    or row["host"] in seen or not isinstance(row.get("reason"), str)
                    or len(row["reason"].strip()) < 30):
                errors.append("invalid held candidate declaration")
    result["candidate_count"] = len(candidates)
    if snapshots is not None:
        if set(snapshots) != {"tracking", "allowlist"}:
            errors.append("missing upstream blob snapshot")
        elif set(sources) == {"tracking", "allowlist"} and all(valid_source(s) for s in sources.values()):
            lines = {}
            for key, content in snapshots.items():
                if not isinstance(content, bytes):
                    errors.append("snapshot must be bytes")
                    continue
                if git_blob_sha(content) != sources[key]["git_blob_sha"]:
                    errors.append("upstream blob SHA mismatch: " + key)
                    continue
                try:
                    lines[key] = content.decode("utf-8-sig").splitlines()
                except UnicodeError:
                    errors.append("upstream text encoding mismatch: " + key)
            if len(lines) == 2:
                for row in candidates:
                    if not isinstance(row, dict) or not isinstance(row.get("line"), int):
                        continue
                    n = row["line"]
                    if n < 1 or n > len(lines["tracking"]) or lines["tracking"][n-1] != row.get("exact_upstream_rule"):
                        errors.append("pinned upstream rule/line mismatch: " + str(row.get("host")))
                    host = row.get("host")
                    if isinstance(host, str):
                        pattern = re.compile(r"(?<![A-Za-z0-9_.-])" + re.escape(host) + r"(?![A-Za-z0-9_.-])", re.I)
                        if any(pattern.search(line) for line in lines["allowlist"]):
                            errors.append("selected upstream allowlist contains exception reference: " + host)
                if not errors:
                    result["upstream_snapshot"] = "PASS"
        else:
            errors.append("upstream snapshot cannot be validated against missing or malformed source metadata")
    result["metadata"] = "PASS" if not errors else "FAIL"
    return errors, result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fetch-upstream", action="store_true",
                        help="read immutable pinned upstream files, verify Git blob SHA and exact rule lines")
    parser.add_argument("--report", type=Path, help="optional JSON report destination")
    args = parser.parse_args()
    try:
        records = read_json(ROOT / "verification/filter-candidates.json")
        profiles = read_json(ROOT / "filter-profiles.json")
        sources = records.get("sources", {})
        snapshots = None
        if args.fetch_upstream:
            if not isinstance(sources, dict) or not all(valid_source(x) for x in sources.values()):
                raise ValueError("cannot fetch malformed source records")
            snapshots = {name: fetch_pinned(source) for name, source in sources.items()}
        errors, report = audit(records, profiles, snapshots=snapshots)
    except (OSError, ValueError, TypeError, KeyError) as error:
        errors, report = [str(error)], {"metadata": "FAIL", "upstream_snapshot": "FAIL" if args.fetch_upstream else "NOT_RUN",
                                       "live_site_e2e": "NOT_RUN", "publication": "NEEDS_HUMAN"}
    report["errors"] = errors
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if errors:
        for error in errors:
            print("ERROR:", error, file=sys.stderr)
        print("CANDIDATE AUDIT FAILED")
        return 1
    print("CANDIDATE AUDIT PASSED:", report["candidate_count"], "opt-in candidates;",
          "upstream snapshot:", report["upstream_snapshot"], "; live E2E: NOT_RUN")
    return 0


if __name__ == "__main__":
    sys.exit(main())
