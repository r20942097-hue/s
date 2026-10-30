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
# Invalid TLD reserved for synthetic testing; must never enter published lists.
CONTROL_HOST = "isolated-import-test.invalid"
CONTROL_RULE = f"||{CONTROL_HOST}^$third-party"


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
            + "! Test-only control below: never commit to a filter output\n"
            + "\n".join(first + last + [CONTROL_RULE]) + "\n").encode("utf-8")


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
    if type(accepted) is not int or accepted < 8:
        raise ValueError("seven candidates and test-only control not fully accepted")
    return {"registered": True, "enabled": True, "download_requests": fetches,
            "accepted_filters": accepted, "compiled_rule_stats": item["rules"]}


def hypothetical_control(page):
    """Read-only: query the actual extension DNR engine about a unique fake host."""
    return page.evaluate("""async hostname => {
        const request = {
            url: 'https://' + hostname + '/fixture-image.gif',
            initiator: 'https://example.org/',
            type: 'image',
            method: 'get'
        };
        const outcome = await chrome.declarativeNetRequest.testMatchOutcome(request);
        const dynamic = await chrome.declarativeNetRequest.getDynamicRules();
        const session = await chrome.declarativeNetRequest.getSessionRules();
        const actions = [];
        for (const row of (outcome.matchedRules || [])) {
            const collection = row.rulesetId === '_session' ? session :
                               row.rulesetId === '_dynamic' ? dynamic : [];
            const found = collection.find(x => x.id === row.ruleId);
            actions.push({ruleset_id: row.rulesetId, action_type:
                          found ? found.action.type : 'UNKNOWN'});
        }
        return {
            match_count: actions.length,
            block_action_count: actions.filter(a => a.action_type === 'block').length,
            matches: actions
        };
    }""", CONTROL_HOST)


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
            # Separate baseline from the imported-list intervention.
            before = hypothetical_control(page)
            if before["match_count"] != 0:
                raise ValueError("fixture host unexpectedly blocked by stock uBOL")
            initial_sets = page.evaluate(
                "() => chrome.runtime.sendMessage({what:'getEnabledRulesets'})")
            if not isinstance(initial_sets, list) or not initial_sets:
                raise ValueError("cannot capture initial uBOL enabled rulesets")
            # Run the same message path as uBOL's dashboard, with no extension
            # source edits and no direct DNR rule injection.
            page.evaluate("""async sourceUrl => {
                await chrome.runtime.sendMessage({what:'importFilterList', url:sourceUrl});
            }""", url)
            # compilation happens in the background; wait for the actual
            # imported-list stats rather than treating message ACK as success.
            page.wait_for_function("""async sourceUrl => {
                const items = await chrome.runtime.sendMessage({what:'getImportedLists'});
                const item = Array.isArray(items) && items.find(x => x.id === sourceUrl);
                return item && item.enabled === true
                    && item.filters && item.filters.accepted >= 8;
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
            # The imported list is only proved active if the unique fixture
            # host's block action is visible to the browser's native DNR engine.
            page.wait_for_function("""async hostname => {
                const matches = (await chrome.declarativeNetRequest.testMatchOutcome({
                    url: 'https://' + hostname + '/fixture-image.gif',
                    initiator: 'https://example.org/', type: 'image', method: 'get'
                })).matchedRules || [];
                return matches.length > 0;
            }""", arg=CONTROL_HOST, timeout=20000)
            after = hypothetical_control(page)
            if after["block_action_count"] < 1:
                raise ValueError("imported local control did not activate a block action")
            stats["control_before"] = before
            stats["control_after_import"] = after
            # Exercise the official uBOL unsubscribe path in the same
            # ephemeral profile, and verify reversal of the DNR change.
            page.evaluate("""async data => {
                await chrome.runtime.sendMessage({
                    what: 'applyRulesets', enabledRulesets: data.initial_sets,
                    toRemove: [data.url]
                });
            }""", {"initial_sets": initial_sets, "url": url})
            page.wait_for_function("""async data => {
                const lists = await chrome.runtime.sendMessage({what:'getImportedLists'});
                return Array.isArray(lists) && !lists.some(x => x.id === data.url);
            }""", arg={"url": url}, timeout=20000)
            page.wait_for_function("""async hostname => {
                const result = await chrome.declarativeNetRequest.testMatchOutcome({
                    url: 'https://' + hostname + '/fixture-image.gif',
                    initiator: 'https://example.org/', type: 'image', method: 'get'
                });
                return (result.matchedRules || []).length === 0;
            }""", arg=CONTROL_HOST, timeout=20000)
            stats["control_after_unsubscribe"] = hypothetical_control(page)
            stats["unsubscribe_reverted"] = (
                stats["control_after_unsubscribe"]["match_count"] == 0)
            if not stats["unsubscribe_reverted"]:
                raise ValueError("local candidate unsubscribe did not revert DNR")
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
              "fixture_only_control_rules": 1,
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
          "fixture block", status["observations"]["control_after_import"]["block_action_count"],
          "; unsubscribed", status["observations"]["unsubscribe_reverted"],
          "; no real site/benefit/Firefox validation")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
