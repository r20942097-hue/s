"""Experimental uBO Lite import/removeparam end-to-end on loopback HTTP only.

No production rules, real websites, user browser profiles, authentication,
purchases or network tracker hosts. This research fixture imports one
speculative query-modifier rule and removes it before profile teardown.

An incremental observation on a synthetic .test host does not prove safety on
any signed URL or live site and cannot authorize automatic adoption.
"""
import argparse
import json
from pathlib import Path
import tempfile
import traceback

from audit_filter_candidates import ROOT
from ubol_imported_list_fixture import serve_list
from ubol_local_param_http_probe import server, build_urls, exercise, compare, RULES
from ubol_real_addon_fixture import LOCK_PATH, fetch_archive, extract_verified, validate_runtime_identity

RULE = "*$removeparam=utm_source"
TEST_PAYLOAD = ("! Title: Isolated single-parameter modifier laboratory only\n"
                "! Never publish this synthetic candidate without real-site safety validation\n"
                + RULE + "\n").encode("utf-8")


def subset(rows):
    chosen = ("utm_source", "fbclid", "gclid", "state", "code", "X-Amz-Signature")
    selection = [r for r in rows if r["key"] in chosen]
    if len(selection) != len(chosen):
        raise ValueError("missing tracked/auth URL controls")
    return selection


def check_import(items, url, minimum):
    matching = [item for item in items
                if isinstance(item, dict) and item.get("id") == url]
    if len(matching) != 1:
        raise ValueError("test URL-modifier list must be registered exactly once")
    item = matching[0]
    accepted = item.get("filters", {}).get("accepted")
    if item.get("enabled") is not True or type(accepted) is not int or accepted < minimum:
        raise ValueError("official uBO Lite did not accept/enable test removeparam")
    return {"accepted": accepted, "rules": item.get("rules")}


def exercise_import(root, manifest, source_url, feed, site):
    from playwright.sync_api import sync_playwright
    with tempfile.TemporaryDirectory(prefix="ubol-param-import-profile-") as profile, sync_playwright() as pw:
        context = pw.chromium.launch_persistent_context(
            profile, channel="chromium", headless=True,
            args=[*RULES,
                  f"--disable-extensions-except={root}",
                  f"--load-extension={root}"])
        try:
            workers = context.service_workers
            worker = workers[0] if workers else context.wait_for_event("serviceworker", timeout=30000)
            extension_id = worker.url.split("/")[2]
            meta = worker.evaluate("""async () => ({
                name: chrome.runtime.getManifest().name,
                version: chrome.runtime.getManifest().version,
                manifest_version: chrome.runtime.getManifest().manifest_version,
                enabled_ruleset_ids: await chrome.declarativeNetRequest.getEnabledRulesets()
            })""")
            validate_runtime_identity(meta, manifest)
            page = context.new_page()
            page.goto(f"chrome-extension://{extension_id}/dashboard.html", wait_until="domcontentloaded")
            initial = page.evaluate(
                "() => chrome.runtime.sendMessage({what:'getEnabledRulesets'})")
            if not isinstance(initial, list) or not initial:
                raise ValueError("unable to read default uBO Lite list configuration")
            rows = subset(build_urls(site.server_port))
            before = exercise(context, rows, site)
            baseline = next(x for x in before if x["key"] == "utm_source")
            if not baseline["parameter_present"]:
                raise ValueError("utm_source already stripped by baseline; no possible incremental value")

            page.evaluate("""async url => chrome.runtime.sendMessage({
                what: 'importFilterList', url
            })""", source_url)
            page.wait_for_function("""async url => {
                const list = await chrome.runtime.sendMessage({what:'getImportedLists'});
                const found = Array.isArray(list) && list.find(x => x.id === url);
                return found && found.enabled === true
                    && found.filters && found.filters.accepted >= 1;
            }""", arg=source_url, timeout=30000)
            details = check_import(
                page.evaluate("() => chrome.runtime.sendMessage({what:'getImportedLists'})"),
                source_url, 1)
            page.wait_for_function("""async url => {
                const key = 'rulesets.imported.compiled.' + url;
                const data = await chrome.storage.local.get(key);
                return Boolean(data[key]);
            }""", arg=source_url, timeout=20000)
            after = exercise(context, rows, site)
            comparison = compare(before, after)
            utm = next(x for x in comparison if x["key"] == "utm_source")
            if not utm["with_stock_ubol_removed"]:
                raise ValueError("imported removeparam rule did not remove utm_source in real HTTP")
            for r in comparison:
                if r["category"] == "MUST_PRESERVE" and not r["with_stock_ubol_present"]:
                    raise ValueError("imported rule broke auth/signed query control")

            page.evaluate("""async data => chrome.runtime.sendMessage({
                what: 'applyRulesets', enabledRulesets: data.enabled,
                toRemove: [data.url]
            })""", {"enabled": initial, "url": source_url})
            page.wait_for_function("""async url => {
                const lists = await chrome.runtime.sendMessage({what:'getImportedLists'});
                return Array.isArray(lists) && !lists.some(x => x.id === url);
            }""", arg=source_url, timeout=20000)
            restored = exercise(context, rows, site)
            original_utm = next(x for x in restored if x["key"] == "utm_source")
            if not original_utm["parameter_present"]:
                raise ValueError("removeparam effect not reverted by official unsubscribe")
            # The stock protections of two known click IDs must remain active.
            click_keys = {"fbclid", "gclid"}
            if any(x["parameter_present"] for x in after if x["key"] in click_keys):
                raise ValueError("import disrupted baseline stock click-ID protection")
            page.close()
            return {
                "fixture_rule": RULE, "imported_url_is_localhost": source_url.startswith("http://127.0.0.1:"),
                "local_source_downloads": feed.fetches,
                "accepted_filters": details["accepted"],
                "utm_source_before": "PRESENT",
                "utm_source_with_import": "REMOVED",
                "utm_source_after_unsubscribe": "PRESENT",
                "signature_and_auth_controls": "PRESERVED",
                "stock_click_id_protection": "RETAINED",
                "synthetic_only": True
            }
        finally:
            context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    report = {
        "schema": "filter-lab-url-modifier/v1",
        "rule": RULE, "published_rules": 0,
        "live_site_compatibility": "NOT_RUN",
        "signed_real_urls_tested": False,
        "incremental_value_live_site": "NOT_ESTABLISHED",
        "publication": "NO_GO", "result": "FAIL"
    }
    try:
        lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
        archive = fetch_archive(lock)
        with (tempfile.TemporaryDirectory(prefix="ubol-parameter-lab-") as tmp,
              server() as site, serve_list(TEST_PAYLOAD) as (source_url, feed)):
            root, manifest = extract_verified(archive, lock, Path(tmp) / "unmodified-ubol")
            outcome = exercise_import(root, manifest, source_url, feed, site)
        report["result"] = "PASS"
        report["observations"] = outcome
        if args.report:
            target = args.report.resolve()
            if target.is_relative_to(ROOT.resolve()):
                raise ValueError("report must not be placed inside source repository")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    except Exception as error:
        print("URL REMOVE PARAM LAB FAILED:", type(error).__name__, str(error))
        traceback.print_exc()
        return 1
    print("URL REMOVE PARAM LAB: PASS - utm_source PRESENT/REMOVED/PRESENT;",
          "stock fbclid/gclid preserved; OAuth/signature controls maintained;",
          "local HTTP only; no production adoption")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
