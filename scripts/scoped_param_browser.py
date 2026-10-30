"""Temporary real uBO Lite scope test using Playwright Chromium."""
from pathlib import Path
import tempfile
from scoped_param_controls import CASES, query, parse_received, verify
from ubol_local_param_http_probe import HOST, RULES
from ubol_param_import_lab import check_import
from ubol_real_addon_fixture import validate_runtime_identity

def observe(ctx, site):
    page = ctx.new_page()
    rows = {}
    try:
        for name, path, signed in CASES:
            old = len(site.paths)
            url = f"http://{HOST}:{site.server_port}{path}?{query(signed)}"
            response = page.goto(url, wait_until="load", timeout=20000)
            if not response or response.status != 200:
                raise ValueError("HTTP failure: " + name)
            received = site.paths[old:]
            if len(received) != 1:
                raise ValueError("wrong request count: " + name)
            rows[name] = parse_received(received[0], path, signed)
    finally:
        page.close()
    return rows

def exercise(root, manifest, url, feed, site):
    from playwright.sync_api import sync_playwright
    with tempfile.TemporaryDirectory(prefix="ubol-scoped-profile-") as profile, sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            profile, channel="chromium", headless=True,
            args=[*RULES, f"--disable-extensions-except={root}",
                  f"--load-extension={root}"])
        try:
            workers = ctx.service_workers
            worker = workers[0] if workers else ctx.wait_for_event("serviceworker", timeout=30000)
            identity = worker.evaluate("""async () => ({
                name: chrome.runtime.getManifest().name,
                version: chrome.runtime.getManifest().version,
                manifest_version: chrome.runtime.getManifest().manifest_version,
                enabled_ruleset_ids: await chrome.declarativeNetRequest.getEnabledRulesets()
            })""")
            validate_runtime_identity(identity, manifest)
            extension_id = worker.url.split("/")[2]
            admin = ctx.new_page()
            admin.goto(f"chrome-extension://{extension_id}/dashboard.html",
                       wait_until="domcontentloaded")
            initial = admin.evaluate("() => chrome.runtime.sendMessage({what:'getEnabledRulesets'})")
            if not isinstance(initial, list) or not initial:
                raise ValueError("no stock rulesets")
            before = observe(ctx, site)
            admin.evaluate("""async url => chrome.runtime.sendMessage({
                what:'importFilterList', url
            })""", url)
            admin.wait_for_function("""async url => {
                const items = await chrome.runtime.sendMessage({what:'getImportedLists'});
                return Array.isArray(items) && items.some(x => x.id === url &&
                    x.enabled === true && x.filters && x.filters.accepted >= 1);
            }""", arg=url, timeout=30000)
            check_import(admin.evaluate(
                "() => chrome.runtime.sendMessage({what:'getImportedLists'})"), url, 1)
            admin.wait_for_function("""async url => {
                const key='rulesets.imported.compiled.' + url;
                const data=await chrome.storage.local.get(key);
                return Boolean(data[key]);
            }""", arg=url, timeout=20000)
            during = observe(ctx, site)
            admin.evaluate("""async data => chrome.runtime.sendMessage({
                what:'applyRulesets', enabledRulesets:data.enabled, toRemove:[data.url]
            })""", {"enabled": initial, "url": url})
            admin.wait_for_function("""async url => {
                const items=await chrome.runtime.sendMessage({what:'getImportedLists'});
                return Array.isArray(items) && !items.some(x => x.id === url);
            }""", arg=url, timeout=20000)
            after = observe(ctx, site)
            if feed.fetches < 1:
                raise ValueError("no fixture list HTTP fetch")
            return verify(before, during, after)
        finally:
            ctx.close()
