"""Experimental uBO Lite import/removeparam end-to-end on loopback HTTP only.

No production rules, real websites, user browser profiles, authentication,
purchases or network tracker hosts. This research fixture imports one
speculative query-modifier rule and removes it before profile teardown.

An incremental observation on a synthetic .test host does not prove safety on
any signed URL or live site and cannot authorize automatic adoption.
"""
import argparse
import hashlib
import hmac
import json
from urllib.parse import urlencode, urlsplit, parse_qsl
from pathlib import Path
import tempfile
import traceback

from audit_filter_candidates import ROOT
from ubol_imported_list_fixture import serve_list
from ubol_local_param_http_probe import server, build_urls, exercise, compare, RULES, HOST
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


def fixture_signature_check(request_path):
    """Validate fake HMAC over *all* unsigned parameters, not real credentials."""
    parsed = urlsplit(request_path)
    parameters = parse_qsl(parsed.query, keep_blank_values=True)
    if (parsed.path != "/fixture"
            or len(parameters) != len({key for key, _ in parameters})):
        raise ValueError("signed fixture request was malformed")
    values = dict(parameters)
    signature = values.get("X-Amz-Signature")
    unsigned = [(key, value) for key, value in parameters if key != "X-Amz-Signature"]
    expected = hmac.new(b"isolated-fixture-test-key", urlencode(unsigned).encode("utf-8"),
                        hashlib.sha256).hexdigest()
    return {
        "signature_valid": isinstance(signature, str) and
                           hmac.compare_digest(signature, expected),
        "signature_preserved": signature is not None,
        "utm_source_present": "utm_source" in values
    }


def observe_signed_fixture(context, site):
    """Signed URL is synthetic: used only to demonstrate broad-rule breakage."""
    original = (("utm_source", "synthetic"), ("keep", "ok"))
    query = urlencode(original)
    signature = hmac.new(b"isolated-fixture-test-key", query.encode("utf-8"),
                         hashlib.sha256).hexdigest()
    request_url = (f"http://{HOST}:{site.server_port}/fixture?"
                   + query + "&X-Amz-Signature=" + signature)
    before_count = len(site.paths)
    page = context.new_page()
    try:
        response = page.goto(request_url, wait_until="load", timeout=20000)
        if response is None or response.status != 200:
            raise ValueError("signed local HTTP request was not delivered")
    finally:
        page.close()
    paths = site.paths[before_count:]
    if len(paths) != 1:
        raise ValueError("signed local HTTP request count incorrect")
    return fixture_signature_check(paths[0])


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
            signed_before = observe_signed_fixture(context, site)
            if signed_before["signature_valid"] is not True:
                raise ValueError("signed-url baseline HMAC failed before experimental filter")
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
            signed_after = observe_signed_fixture(context, site)
            if signed_after["signature_preserved"] is not True:
                raise ValueError("experimental filter removed signature parameter")
            # Existing stock uBOL already removes fbclid/gclid; they are
            # retention controls, NOT part of the before/after delta's
            # "all baseline params present" precondition.
            click_keys = {"fbclid", "gclid"}
            before_delta = [x for x in before if x["key"] not in click_keys]
            after_delta = [x for x in after if x["key"] not in click_keys]
            comparison = compare(before_delta, after_delta)
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
            signed_restored = observe_signed_fixture(context, site)
            if signed_restored["signature_valid"] is not True:
                raise ValueError("signed-url integrity did not recover after unsubscribe")
            original_utm = next(x for x in restored if x["key"] == "utm_source")
            if not original_utm["parameter_present"]:
                raise ValueError("removeparam effect not reverted by official unsubscribe")
            # The stock protections of two known click IDs must remain active.
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
                "signature_and_auth_controls": "PRESERVED_IN_ISOLATION",
                "synthetic_signed_url_integrity_before": "PASS",
                "synthetic_signed_url_integrity_with_global_rule":
                    "PASS" if signed_after["signature_valid"] else "BROKEN",
                "synthetic_signed_url_integrity_after_unsubscribe": "PASS",
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
          "synthetic signed URL with global rule:",
          report["observations"]["synthetic_signed_url_integrity_with_global_rule"],
          "; stock fbclid/gclid preserved; local HTTP only; no adoption")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
