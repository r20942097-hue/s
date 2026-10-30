"""Verify real Chromium MV3 declarativeNetRequest on a local isolated site.

This uses an ephemeral, minimal *test-only* MV3 extension, NOT uBlock Origin,
uBO Lite, AdGuard or the candidate filter lists. It proves the native browser
rule engine and persistent extension launch work in CI; live-site validation
and actual subscription uptake remain NOT_RUN.
"""
import argparse
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import traceback

from browser_fixture_smoke import fixture_server


def build_extension(path, port):
    """Create only local, short-lived fixture rules, never production artifacts."""
    path.mkdir(parents=True, exist_ok=False)
    manifest = {
        "manifest_version": 3,
        "name": "Isolated Local DNR Fixture",
        "version": "0.0.1",
        "permissions": ["declarativeNetRequest"],
        "background": {"service_worker": "background.js"},
        "declarative_net_request": {
            "rule_resources": [{"id": "fixture_rules", "enabled": True, "path": "rules.json"}]
        }
    }
    rules = [{
        "id": 1, "priority": 1,
        "action": {"type": "block"},
        "condition": {
            "urlFilter": f"|http://127.0.0.1:{port}/beacon",
            "domainType": "thirdParty",
            "resourceTypes": ["image"]
        }
    }]
    (path / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (path / "rules.json").write_text(json.dumps(rules, indent=2), encoding="utf-8")
    (path / "background.js").write_text(
        "chrome.runtime.onInstalled.addListener(() => {});\n", encoding="utf-8")


def trigger_remote(page, port, phase):
    url = f"http://127.0.0.1:{port}/beacon?phase={phase}"
    return page.evaluate("""url => new Promise(resolve => {
        const image = new Image();
        image.onload = () => resolve("loaded");
        image.onerror = () => resolve("blocked");
        image.src = url;
    })""", url)


def verify_form(page, expected_origin):
    assert page.url.startswith(expected_origin), "unexpected browser origin"
    page.locator("#user").fill("fixture-user")
    page.locator("#sign-in").click()
    page.wait_for_function("document.querySelector('#status').textContent === 'login-ok'",
                           timeout=10000)
    page.locator("#checkout").click()
    page.wait_for_function("document.querySelector('#status').textContent === 'checkout-ok'",
                           timeout=10000)


def smoke():
    from playwright.sync_api import sync_playwright

    report = {
        "schema": "filter-chromium-dnr-fixture/v1",
        "browser": "Playwright bundled Chromium",
        "extension": "ephemeral MV3 declarativeNetRequest fixture, NOT uBO/uBOL",
        "real_extension_loaded": False,
        "native_dnr_blocking": "NOT_RUN",
        "baseline_control": "NOT_RUN",
        "same_site_control": "NOT_RUN",
        "login_checkout_fixture": "NOT_RUN",
        "live_site_e2e": "NOT_RUN",
        "actual_adblock_extension": "NOT_RUN",
        "candidate_subscription_loaded": False,
        "real_video_playback": "NOT_RUN",
        "publication": "NO_GO"
    }
    with fixture_server() as server, TemporaryDirectory() as tmp, sync_playwright() as p:
        port = server.server_address[1]
        first_party = f"http://127.0.0.1:{port}/"
        third_party = f"http://localhost:{port}/"
        # Baseline positive control: same request succeeds when NO extension exists.
        baseline = p.chromium.launch(headless=True, channel="chromium")
        try:
            context = baseline.new_context()
            page = context.new_page()
            page.goto(third_party, wait_until="load")
            before = server.beacon_hits
            assert trigger_remote(page, port, "without-extension") == "loaded", \
                "baseline cross-site image should load without extension"
            assert server.beacon_hits == before + 1, "baseline request missing at HTTP server"
            verify_form(page, third_party)
            context.close()
            report["baseline_control"] = "PASS"
        finally:
            baseline.close()

        ext_path = Path(tmp) / "minimal-test-extension"
        build_extension(ext_path, port)
        context = p.chromium.launch_persistent_context(
            str(Path(tmp) / "browser-user-data"),
            headless=True, channel="chromium",
            args=[
                f"--disable-extensions-except={ext_path}",
                f"--load-extension={ext_path}"
            ]
        )
        try:
            workers = context.service_workers
            worker = workers[0] if workers else context.wait_for_event("serviceworker", timeout=20000)
            assert worker.url.startswith("chrome-extension://"), "MV3 extension service worker missing"
            activated = worker.evaluate(
                "() => chrome.declarativeNetRequest.getEnabledRulesets()")
            assert "fixture_rules" in activated, "MV3 static ruleset was not enabled"
            report["real_extension_loaded"] = True

            first = context.new_page()
            first.goto(first_party, wait_until="load")
            hits = server.beacon_hits
            assert trigger_remote(first, port, "first-party-control") == "loaded", \
                "same-site request unexpectedly blocked by third-party-only DNR"
            assert server.beacon_hits == hits + 1, "first-party control did not reach server"
            report["same_site_control"] = "PASS"
            first.close()

            third = context.new_page()
            third.goto(third_party, wait_until="load")
            hits = server.beacon_hits
            assert trigger_remote(third, port, "blocked-third-party") == "blocked", \
                "real native DNR failed to block third-party image"
            assert server.beacon_hits == hits, "blocked request unexpectedly reached server"
            verify_form(third, third_party)
            report["native_dnr_blocking"] = "PASS"
            report["login_checkout_fixture"] = "PASS"
            third.close()
        finally:
            context.close()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path,
                        help="write JSON to runner temporary location, not repository")
    args = parser.parse_args()
    try:
        report = smoke()
        if args.report:
            root = Path(__file__).resolve().parents[1]
            target = args.report.resolve()
            if target.is_relative_to(root):
                raise ValueError("report must not be saved in repository")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    except Exception as exc:
        print("CHROMIUM NATIVE DNR FIXTURE FAILED:", type(exc).__name__, str(exc))
        traceback.print_exc()
        return 1
    print("CHROMIUM NATIVE DNR FIXTURE:", report["native_dnr_blocking"],
          "- true temporary MV3 DNR extension; no real adblocker or live website")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
