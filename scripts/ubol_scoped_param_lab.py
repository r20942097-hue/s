"""Isolated uBO Lite scoped query experiment. Never publish."""
import argparse, json, tempfile
from pathlib import Path
from audit_filter_candidates import ROOT
from scoped_param_browser import exercise
from ubol_local_param_http_probe import server
from ubol_imported_list_fixture import serve_list
from ubol_real_addon_fixture import LOCK_PATH, fetch_archive, extract_verified

RULE = "||tracking-fixture.test^*/telemetry/collect?$removeparam=utm_source"

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--report", type=Path)
    args = p.parse_args()
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    data = fetch_archive(lock)
    payload = ("! Lab-only not for publication\n" + RULE + "\n").encode()
    with (tempfile.TemporaryDirectory() as temp, server() as site,
          serve_list(payload) as (url, feed)):
        root, manifest = extract_verified(data, lock, Path(temp) / "official")
        outcome = exercise(root, manifest, url, feed, site)
    report = {"schema": "filter-scoped-param-lab/v1", "result": "PASS",
              "rule": RULE, "observations": outcome,
              "published_rules": 0, "publication": "NO_GO",
              "real_firefox_ubo": "NOT_RUN", "real_site_e2e": "NOT_RUN"}
    if args.report:
        target = args.report.resolve()
        if target.is_relative_to(ROOT.resolve()):
            raise ValueError("report inside repository")
        target.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print("SCOPED PARAM LOCAL HTTP PASS:", outcome)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
