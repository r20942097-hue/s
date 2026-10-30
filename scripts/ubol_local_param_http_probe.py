"""Local-only actual HTTP request probe for official uBO Lite URL parameter protection.

Unlike testMatchOutcome(), this fixture observes real GET request paths arriving
at a loopback HTTP server, using a reserved .test host mapped to 127.0.0.1 by
Chromium's temporary resolver rules. It never contacts real websites and does
not load proposed filter rules.

Before/after comparisons are diagnostic, not an authorization to publish.
"""
import argparse
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import traceback
from urllib.parse import parse_qsl, urlencode, urlsplit

from audit_filter_candidates import ROOT
from ubol_real_addon_fixture import (
    LOCK_PATH, fetch_archive, extract_verified, validate_runtime_identity,
)

HOST = "tracking-fixture.test"
TRACKING = ("utm_source", "fbclid", "gclid")
PRESERVE = ("state", "code", "X-Amz-Signature")
RULES = (f"--host-resolver-rules=MAP {HOST} 127.0.0.1", "--no-proxy-server")


@contextmanager
def server():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if urlsplit(self.path).path != "/fixture":
                self.send_error(404)
                return
            with self.server.records_lock:
                self.server.paths.append(self.path)
            content = b"<!doctype html><title>LOCAL ONLY</title><p>fixture-ok</p>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)

        def log_message(self, *_):
            pass

    instance = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    instance.paths = []
    instance.records_lock = threading.Lock()
    thread = threading.Thread(target=instance.serve_forever, daemon=True)
    thread.start()
    try:
        yield instance
    finally:
        instance.shutdown()
        instance.server_close()
        thread.join(timeout=5)


def build_urls(port):
    rows = []
    for category, keys in (("TRACKING_REVIEW", TRACKING),
                           ("MUST_PRESERVE", PRESERVE)):
        for key in keys:
            query = urlencode(((key, "synthetic-value"), ("keep", "ok")))
            rows.append({
                "key": key, "category": category,
                "url": f"http://{HOST}:{port}/fixture?{query}",
                "expected": {key: "synthetic-value", "keep": "ok"}
            })
    return rows


def exercise(context, rows, fixture):
    page = context.new_page()
    results = []
    try:
        for item in rows:
            before = len(fixture.paths)
            response = page.goto(item["url"], wait_until="load", timeout=20000)
            if response is None or response.status != 200:
                raise ValueError("local synthetic request failed")
            if page.title() != "LOCAL ONLY":
                raise ValueError("synthetic response did not load")
            paths = fixture.paths[before:]
            if len(paths) != 1:
                raise ValueError("expected exactly one request to local HTTP fixture")
            received = urlsplit(paths[0])
            actual = parse_qsl(received.query, keep_blank_values=True)
            if received.path != "/fixture" or len(actual) != len(set(k for k, _ in actual)):
                raise ValueError("malformed local HTTP request")
            values = dict(actual)
            if values.get("keep") != "ok":
                raise ValueError("safe query control was unexpectedly removed or changed")
            results.append({
                "key": item["key"], "category": item["category"],
                "observed_at_local_server": True,
                "parameter_present": values.get(item["key"]) == "synthetic-value",
                "parameter_missing": item["key"] not in values,
                "safe_control_preserved": True,
                "actual_url_values_not_logged": True
            })
    finally:
        page.close()
    return results


def compare(baseline, active):
    if (len(baseline) != len(active) or not baseline
            or len(baseline) > len(TRACKING) + len(PRESERVE)):
        raise ValueError("missing or invalid local HTTP comparison cases")
    keys = [item.get("key") for item in baseline]
    if len(set(keys)) != len(keys) or any(key not in TRACKING + PRESERVE for key in keys):
        raise ValueError("invalid or duplicate local HTTP comparison keys")
    rows = []
    for before, after in zip(baseline, active):
        if (before["key"] != after["key"]
                or before["category"] != after["category"]
                or before["parameter_present"] is not True
                or before["safe_control_preserved"] is not True
                or after["safe_control_preserved"] is not True):
            raise ValueError("baseline/active local HTTP controls not reliable")
        if before["category"] == "MUST_PRESERVE" and not after["parameter_present"]:
            raise ValueError("official stock extension damaged signed/auth query control")
        rows.append({
            "key": before["key"], "category": before["category"],
            "baseline_present": before["parameter_present"],
            "with_stock_ubol_present": after["parameter_present"],
            "with_stock_ubol_removed": after["parameter_missing"],
            "incremental_value_of_proposed_rules": "NOT_ESTABLISHED",
            "real_public_site_e2e": "NOT_RUN"
        })
    return rows


def smoke():
    from playwright.sync_api import sync_playwright
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    data = fetch_archive(lock)
    with (tempfile.TemporaryDirectory(prefix="ubol-local-http-") as work,
          server() as fixture, sync_playwright() as pw):
        extension_root, manifest = extract_verified(
            data, lock, Path(work) / "official-release")
        cases = build_urls(fixture.server_port)
        standard = pw.chromium.launch(headless=True, channel="chromium", args=list(RULES))
        try:
            context = standard.new_context()
            before = exercise(context, cases, fixture)
            context.close()
        finally:
            standard.close()

        context = pw.chromium.launch_persistent_context(
            str(Path(work) / "profile"),
            headless=True, channel="chromium",
            args=[*RULES,
                  f"--disable-extensions-except={extension_root}",
                  f"--load-extension={extension_root}"])
        try:
            workers = context.service_workers
            sw = workers[0] if workers else context.wait_for_event("serviceworker", timeout=30000)
            meta = sw.evaluate("""async () => ({
                name: chrome.runtime.getManifest().name,
                version: chrome.runtime.getManifest().version,
                manifest_version: chrome.runtime.getManifest().manifest_version,
                enabled_ruleset_ids: await chrome.declarativeNetRequest.getEnabledRulesets()
            })""")
            validate_runtime_identity(meta, manifest)
            after = exercise(context, cases, fixture)
        finally:
            context.close()
    rows = compare(before, after)
    return {
        "schema": "filter-real-ubol-local-query-probe/v1",
        "pinned_release": lock["release_tag"], "pinned_sha256": lock["sha256"],
        "transport": "real loopback HTTP on reserved mapped .test host",
        "live_external_website": "NOT_RUN", "user_browser_profile": "UNTOUCHED",
        "tracking_url_cases": len(TRACKING),
        "must_preserve_cases": len(PRESERVE),
        "rows": rows,
        "stock_removed_count": sum(x["with_stock_ubol_removed"] for x in rows
                                   if x["category"] == "TRACKING_REVIEW"),
        "new_rules_added": 0,
        "incremental_benefit": "NOT_ESTABLISHED", "publication": "NO_GO"
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    try:
        report = smoke()
        if args.report:
            dest = args.report.resolve()
            if dest.is_relative_to(ROOT.resolve()):
                raise ValueError("report must be outside checkout")
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print("REAL LOCAL PARAM HTTP PROBE: tracking cases", len(TRACKING),
              "actually removed by stock:", report["stock_removed_count"],
              "sensitive controls maintained:", len(PRESERVE),
              "; no external sites or new rules")
        for item in report["rows"]:
            print("LOCAL PARAM CASE:", item["key"], item["category"],
                  "stock_removed", item["with_stock_ubol_removed"])
    except Exception as error:
        print("REAL LOCAL PARAM HTTP PROBE FAILED:", type(error).__name__, str(error))
        traceback.print_exc()
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
