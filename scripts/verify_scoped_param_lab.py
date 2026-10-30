"""Fail-closed browser evidence gate for nonpublished scoped URL experiment."""
import argparse, json, sys
from pathlib import Path

def audit(result):
    x = result.get("observations")
    if (result.get("schema") != "filter-scoped-param-lab/v1"
            or result.get("result") != "PASS"
            or result.get("published_rules") != 0
            or result.get("publication") != "NO_GO"
            or result.get("real_firefox_ubo") != "NOT_RUN"
            or result.get("real_site_e2e") != "NOT_RUN"
            or not isinstance(x, dict)
            or x.get("target") != "PRESENT_REMOVED_RESTORED"
            or x.get("other_paths") != "PRESERVED"
            or x.get("other_signed_urls") != "PRESERVED"
            or x.get("signed_before_after") != "PASS"
            or x.get("same_endpoint_signed") not in ("BROKEN", "PASS")
            or x.get("real_site") != "NOT_RUN"):
        return ["invalid scope evidence or unverified release claim"]
    return []

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--github-summary", type=Path)
    args = parser.parse_args()
    try:
        record = json.loads(args.report.read_text(encoding="utf-8"))
        errors = audit(record)
        signed = (record.get("observations") or {}).get("same_endpoint_signed")
        content = ("## Scoped URL privacy lab (isolated HTTP)\n\n"
                   + "**Validation: " + ("FAIL" if errors else "PASS") + "**\n\n"
                   + "Tracking path: cleaned; other paths: preserved.\n\n"
                   + "Synthetic signed request on same path: **" + str(signed)
                   + "**. A path-only rule cannot be declared safe.\n\n"
                   + "Real Firefox/site compatibility: NOT_RUN. Publication: NO_GO.\n\n")
        if args.github_summary:
            with args.github_summary.open("a", encoding="utf-8") as f:
                f.write(content)
        else:
            print(content)
        for error in errors:
            print("SCOPE LAB ERROR:", error, file=sys.stderr)
        return int(bool(errors))
    except (OSError, ValueError, TypeError) as error:
        print("SCOPE LAB ERROR:", error, file=sys.stderr)
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
