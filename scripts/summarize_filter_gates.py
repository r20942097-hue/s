"""Consolidate immutable filter CI evidence into one fail-closed job summary.

This is not a release/merge approval. It reports only automated checks and
retains live-browser validation as NOT_RUN.
"""
import argparse
import json
from pathlib import Path
import sys


def gather(stable, candidate, delta, drift):
    errors = []
    if stable.get("schema") != "filter-stable-fidelity-check/v1" or stable.get("status") != "PASS":
        errors.append("stable byte-fidelity gate not PASS")
    if (stable.get("protected_asset_count") != 8
            or stable.get("verified_asset_count") != 8
            or stable.get("errors")):
        errors.append("stable asset count mismatch or errors")
    if (candidate.get("record_schema") != "filter-candidates/v1"
            or candidate.get("metadata") != "PASS"
            or candidate.get("upstream_snapshot") != "PASS"
            or candidate.get("candidate_count") != 4 or candidate.get("errors")):
        errors.append("candidate source/evidence audit not PASS")
    if (delta.get("schema") != "upstream-delta-review/v2"
            or delta.get("selected_independent_easyprivacy_comparison") != "PASS"
            or delta.get("publication") != "NO_GO"):
        errors.append("independent comparison or candidate publication guard failed")
    if (not isinstance(delta.get("queue_total"), int)
            or delta["queue_total"] != delta.get("new_candidate_hosts")
            or not isinstance(delta.get("candidate_hosts_also_observed_in_selected_easyprivacy"), int)
            or not isinstance(delta.get("candidate_hosts_with_selected_easyprivacy_full_host_rule"), int)
            or not isinstance(delta.get("candidate_hosts_with_selected_easyprivacy_scoped_rule_only"), int)
            or delta["candidate_hosts_with_selected_easyprivacy_full_host_rule"]
              + delta["candidate_hosts_with_selected_easyprivacy_scoped_rule_only"]
              != delta["candidate_hosts_also_observed_in_selected_easyprivacy"]):
        errors.append("inconsistent delta and independent coverage metrics")
    if (drift.get("schema") != "filter-upstream-drift/v1"
            or drift.get("sources_checked") != 4
            or drift.get("automatic_source_pin_update") is not False
            or drift.get("publication") != "NO_GO"):
        errors.append("upstream drift report invalid or auto-promotion enabled")
    if not isinstance(drift.get("drift_files"), int) or not 0 <= drift["drift_files"] <= 4:
        errors.append("drift count invalid")
    if any(report.get("live_site_e2e") != "NOT_RUN" for report in
           (stable, candidate, delta, drift)):
        errors.append("unexpected live-browser E2E status")
    if candidate.get("publication") != "NEEDS_HUMAN":
        errors.append("candidate publication must require owner")
    return errors


def render(stable, candidate, delta, drift, errors):
    status = "FAIL" if errors else "PASS (automated only)"
    lines = [
        "## Filter candidate CI quality gate",
        "",
        f"**Automated gate: {status}** — publication: **NO_GO / NEEDS_HUMAN**",
        "",
        "| Check | Observation |",
        "|---|---|",
        f"| Protected main assets | {stable.get('verified_asset_count', '?')}/8 exact pinned Git blobs |",
        f"| Experimental candidate provenance | {candidate.get('candidate_count', '?')} rules; pinned sources: {candidate.get('upstream_snapshot', '?')} |",
        f"| Local candidate review queue | {delta.get('queue_total', '?')} hosts, not safety-reviewed |",
        f"| Selected independent EasyPrivacy | {delta.get('candidate_hosts_also_observed_in_selected_easyprivacy', '?')} observed; full-host-shaped: {delta.get('candidate_hosts_with_selected_easyprivacy_full_host_rule', '?')}, scoped: {delta.get('candidate_hosts_with_selected_easyprivacy_scoped_rule_only', '?')} |",
        f"| Selected allowlist possible exceptions | {delta.get('candidate_hosts_with_selected_allowlist_exception', '?')}; may be path/type/site-restricted |",
        f"| Pinned vs latest upstream blobs | {drift.get('drift_files', '?')} changed of 4 checked; pins not auto-updated |",
        "| Real-site login / checkout / video | NOT_RUN |",
        "| Auto-adopt, stable promotion, merge | FORBIDDEN / NEEDS_HUMAN |",
        "",
        "The figures do not establish actual user-visible blocking, accuracy on live websites, installed-list coverage or permission to publish. CI logs and summaries have finite retention."
    ]
    if errors:
        lines.extend(["", "### Gate errors"] + ["- " + problem for problem in errors])
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("stable", "candidate", "delta", "drift"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--github-summary", type=Path, help="append markdown to GitHub job summary")
    args = parser.parse_args()
    try:
        reports = []
        for name in ("stable", "candidate", "delta", "drift"):
            reports.append(json.loads(getattr(args, name).read_text(encoding="utf-8")))
        errors = gather(*reports)
        markdown = render(*reports, errors)
        if args.github_summary:
            with args.github_summary.open("a", encoding="utf-8") as output:
                output.write(markdown)
        else:
            print(markdown, end="")
    except (OSError, ValueError, TypeError, KeyError) as exc:
        print("QUALITY GATE REPORT FAILED:", exc, file=sys.stderr)
        return 1
    if errors:
        for error in errors:
            print("QUALITY GATE ERROR:", error, file=sys.stderr)
    return int(bool(errors))


if __name__ == "__main__":
    sys.exit(main())
