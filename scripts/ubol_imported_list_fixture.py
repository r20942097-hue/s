"""Isolated imported-list integration test using UNMODIFIED official uBO Lite.

Serves only the seven PR candidate rules from a local HTTP fixture and uses
uBOL's own dashboard/message path. Browser profile, HTTP server and release
extraction are temporary. Neither production lists nor any user profile changes.
A list *being imported* does not establish incremental blocking efficacy.
"""
import argparse
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import traceback

from audit_filter_candidates import ROOT
from ubol_real_addon_fixture import (
    LOCK_PATH, fetch_archive, extract_verified, validate_runtime_identity,
)

EXPECTED_HOSTS = (
    "match.prod.bidr.io", "sync.adkernel.com", "sync.richaudience.com",
    "id5-sync.com", "event.getblue.io", "sync.ebis.ne.jp",
    "pixel.wetracked.io",
)


def candidate_payload(profile):
    if not isinstance(profile, dict) or not isinstance(profile.get("rule_sets"), dict):
        raise ValueError("invalid local candidate registry")
    standard = profile["rule_sets"]["privacy-v2"]["rules"]
    optional = profile["rule_sets"]["privacy-optional-20261030"]["rules"]
    first = [f"||{host}^$third-party" for host in EXPECTED_HOSTS[:3]]
    if not all(rule in standard for rule in first):
        raise ValueError("v2 candidate was changed or removed")
    last = [f"||{host}^$third-party" for host in EXPECTED_HOSTS[3:]]
    # Rules 4-7 are stored in the opt-in set in a different order.
    if sorted(optional) != sorted(last) or len(optional) != 4:
        raise ValueError("unexpected optional candidates; fail closed")
    return ("! Title: Isolated test-only candidate import\n"
            "! Expires: 7 days\n"
            "! This snapshot must never be published or auto-promoted.\n"
            + "\n".join(first + last) + "\n").encode("utf-8")


@contextmanager
def serve_list(payload):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/candidate-list.txt":
                self.send_error(404)
                return
            with self.server.lock:
                self.server.fetches += 1
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.fetches = 0
    server.lock = threading.Lock()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/candidate-list.txt", server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def analyze_imported_list(lists, url, fetches):
    if not isinstance(lists, list):
        raise ValueError("uBOL imported-list response is not an array")
    matches = [x for x in lists if isinstance(x, dict) and x.get("id") == url]
    if len(matches) != 1:
        raise ValueError("candidate list was not registered exactly once")
    item = matches[0]
    if item.get("enabled") is not True:
        raise ValueError("candidate list was registered but not enabled")
    if fetches < 1:
        raise ValueError("candidate source was never fetched from isolated server")
    if not isinstance(item.get("rules"), dict):
        raise ValueError("imported list compilation stats missing")
    accepted = item.get("filters", {}).get("accepted", 0)
    if type(accepted) is not int or accepted < 7:
        raise ValueError("fewer than seven candidate filters accepted")
    return {"registered": True, "enabled": True, "download_requests": fetches,
            "accepted_filters": accepted, "compiled_rule_stats": item["rules"]}


def exercise(extension_root, source_manifest, url, server):
    from playwright.sync_api import sync_playwright
    with tempfile.TemporaryDirectory(prefix="ubol-import-profile-") as profile, sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            profile, channel="chromium", headless=True,
            args=[f"--disable-extensions-except={extension_root}",
                  f"--load-extension={extension_root}"])
        try:
            workers = context.service_workers
            worker = workers[0] if workers else context.wait_for_event("serviceworker", timeout=30000)
            extension_id = worker.url.split("/")[2]
            info = worker.evaluate("""async () => ({
                name: chrome.runtime.getManifest().name,
                version: chrome.runtime.getManifest().version,
                manifest_version: chrome.runtime.getManifest().manifest_version,
                enabled_ruleset_ids: await chrome.declarativeNetRequest.getEnabledRulesets()
            })""")
            validate_runtime_identity(info, source_manifest)
            page = context.new_page()
            page.goto(f"chrome-extension://{extension_id}/dashboard.html", wait_until="domcontentloaded")
            # Run the same message path as uBOL's own dashboard; never modify
            # the official extension source or inject candidate DNR rules.
            page.evaluate("""async sourceUrl => {
                await chrome.runtime.sendMessage({what:'importFilterList', url:sourceUrl});
            }""", url)
            # compilation happens in the background; wait for the actual
            # imported-list stats rather than treating message ACK as success.
            page.wait_for_function("""async sourceUrl => {
                const items = await chrome.runtime.sendMessage({what:'getImportedLists'});
                const item = Array.isArray(items) && items.find(x => x.id === sourceUrl);
                return item && item.enabled === true
                    && item.filters && item.filters.accepted >= 7;
            }""", arg=url, timeout=30000)
            lists = page.evaluate(
                "() => chrome.runtime.sendMessage({what:'getImportedLists'})")
            stats = analyze_imported_list(lists, url, server.fetches)
            stored = page.evaluate("""async sourceUrl => {
                const entry = await chrome.storage.local.get(
                    'rulesets.imported.compiled.' + sourceUrl);
                return Boolean(entry['rulesets.imported.compiled.' + sourceUrl]);
            }""", url)
            if stored is not True:
                raise ValueError("official uBOL did not persist compiled imported list")
            stats["compiled_storage_present"] = True
            page.close()
            return stats
        finally:
            context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    status = {"schema": "filter-real-ubol-import-fixture/v1",
              "real_official_extension": True,
              "candidate_rules_supplied": 7,
              "source_scope": "isolated local HTTP, transient profile",
              "import_compile": "NOT_RUN",
              "actual_live_site_e2e": "NOT_RUN",
              "candidate_incremental_effect": "NOT_ESTABLISHED",
              "firefox_full_ubo": "NOT_RUN",
              "publication": "NO_GO"}
    try:
        profile = json.loads((ROOT / "filter-profiles.json").read_text(encoding="utf-8"))
        payload = candidate_payload(profile)
        lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
        data = fetch_archive(lock)
        with tempfile.TemporaryDirectory(prefix="ubol-import-release-") as work:
            extension_root, manifest = extract_verified(
                data, lock, Path(work) / "unmodified-release")
            with serve_list(payload) as (url, server):
                observed = exercise(extension_root, manifest, url, server)
        status["import_compile"] = "PASS"
        status["observations"] = observed
        if args.report:
            target = args.report.resolve()
            if target.is_relative_to(ROOT.resolve()):
                raise ValueError("report destination is inside repository")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
    except Exception as exc:
        print("OFFICIAL uBOL CANDIDATE IMPORT FAILED:", type(exc).__name__, str(exc))
        traceback.print_exc()
        return 1
    print("OFFICIAL uBOL CANDIDATE IMPORT:", status["import_compile"], ";",
          status["observations"]["accepted_filters"], "accepted;",
          status["observations"]["download_requests"], "local fetches;",
          "no real site/benefit/Firefox validation")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
