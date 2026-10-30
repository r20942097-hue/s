"""Fail-closed checks for isolated real-HTTP parameter experiments."""
import argparse
import json
from pathlib import Path
import sys

def audit(stock, experimental):
    errors = []
    rows = stock.get("rows")
    if (stock.get("schema") != "filter-real-ubol-local-query-probe/v1"
            or stock.get("publication") != "NO_GO"
            or stock.get("live_external_website") != "NOT_RUN"
            or stock.get("new_rules_added") != 0
            or not isinstance(rows, list) or len(rows) != 6):
        errors.append("stock local HTTP evidence missing")
    else:
        expected = {"utm_source": False, "fbclid": True, "gclid": True,
                    "state": False, "code": False, "X-Amz-Signature": False}
        if (set(x.get("key") for x in rows if isinstance(x, dict)) != set(expected)
                or any(not isinstance(x, dict)
                       or x.get("with_stock_ubol_removed") is not expected.get(x.get("key"))
                       or x.get("real_public_site_e2e") != "NOT_RUN"
                       for x in rows)):
            errors.append("stock query control mismatch")
    record = experimental.get("observations")
    if (experimental.get("schema") != "filter-lab-url-modifier/v1"
            or experimental.get("result") != "PASS"
            or experimental.get("published_rules") != 0
            or experimental.get("publication") != "NO_GO"
            or experimental.get("live_site_compatibility") != "NOT_RUN"
            or experimental.get("signed_real_urls_tested") is not False
            or not isinstance(record, dict)
            or record.get("utm_source_before") != "PRESENT"
            or record.get("utm_source_with_import") != "REMOVED"
            or record.get("utm_source_after_unsubscribe") != "PRESENT"
            or record.get("synthetic_signed_url_integrity_before") != "PASS"
            or record.get("synthetic_signed_url_integrity_with_global_rule") != "BROKEN"
            or record.get("synthetic_signed_url_integrity_after_unsubscribe") != "PASS"
            or record.get("stock_click_id_protection") != "RETAINED"):
        errors.append("global param stripping / signature hazard missing")
    return errors

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stock", type=Path, required=True)
    parser.add_argument("--experimental", type=Path, required=True)
    parser.add_argument("--github-summary", type=Path)
    args = parser.parse_args()
    try:
        stock = json.loads(args.stock.read_text(encoding="utf-8"))
        lab = json.loads(args.experimental.read_text(encoding="utf-8"))
        errors = audit(stock, lab)
        summary = ("## Real-local-HTTP privacy control gate\n\n"
                   + "**Status: " + ("FAIL" if errors else "PASS") + "** (synthetic only)\n\n"
                   + "Stock removes fbclid/gclid but not utm_source.\n\n"
                   + "Experimental global utm_source removal breaks synthetic HMAC signed URLs.\n\n"
                   + "No live website or real Firefox uBO verified. Publication: **NO_GO**.\n\n")
        if args.github_summary:
            with args.github_summary.open("a", encoding="utf-8") as file:
                file.write(summary)
        else:
            print(summary)
        for error in errors:
            print("URL PARAMETER SAFETY GATE ERROR:", error, file=sys.stderr)
        return int(bool(errors))
    except (OSError, ValueError, KeyError, TypeError) as error:
        print("URL PARAMETER SAFETY GATE ERROR:", error, file=sys.stderr)
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
