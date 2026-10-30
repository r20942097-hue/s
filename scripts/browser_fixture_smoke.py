"""Isolated, real Chromium/Firefox smoke harness for future filter-site E2E.

The filter surrogate here is Playwright's route.abort(), NOT uBlock Origin,
uBO Lite or AdGuard. Only validates the browser automation and synthetic
login/checkout UI are testable under an intentionally blocked beacon.
No real websites, accounts, credentials or payments are contacted.
"""
import argparse
from base64 import b64decode
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
from urllib.parse import urlsplit

GIF = b64decode("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==")
PAGE = """<!doctype html>
<meta charset='utf-8'><title>Synthetic filter compatibility fixture</title>
<style>body {font-family:sans-serif} #status {padding:8px}</style>
<h1>Local fixture</h1>
<form id='login'><input id='user' required><button id='sign-in'>Sign in</button></form>
<button id='checkout'>Simulated checkout</button>
<video id='player' muted playsinline controls></video>
<output id='status'>idle</output>
<script>
window.triggerBeacon = async (phase) => new Promise(resolve => {
  const pixel = new Image();
  pixel.onload = () => resolve("loaded");
  pixel.onerror = () => resolve("blocked");
  pixel.src = "/beacon?phase=" + encodeURIComponent(phase);
});
document.querySelector("#login").onsubmit = async event => {
  event.preventDefault();
  const r = await fetch("/api/login", {method:"POST", body:"synthetic"});
  document.querySelector("#status").textContent = (await r.json()).result;
};
document.querySelector("#checkout").onclick = async () => {
  const r = await fetch("/api/checkout", {method:"POST",body:"synthetic"});
  document.querySelector("#status").textContent = (await r.json()).result;
};
</script>"""


class FixtureHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        route = urlsplit(self.path).path
        if route == "/":
            self.reply(200, b"text/html; charset=utf-8", PAGE.encode())
        elif route == "/beacon":
            with self.server.counter_lock:
                self.server.beacon_hits += 1
            self.reply(200, b"image/gif", GIF)
        else:
            self.reply(404, b"text/plain", b"not found")

    def do_POST(self):
        route = urlsplit(self.path).path
        n = int(self.headers.get("Content-Length", "0"))
        if n > 128:
            self.reply(413, b"text/plain", b"too long")
            return
        self.rfile.read(n)
        if route in ("/api/login", "/api/checkout"):
            value = "login-ok" if route == "/api/login" else "checkout-ok"
            self.reply(200, b"application/json",
                       json.dumps({"result": value}).encode())
        else:
            self.reply(404, b"text/plain", b"not found")

    def reply(self, status, kind, content):
        self.send_response(status)
        self.send_header("Content-Type", kind.decode())
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, fmt, *args):
        pass


@contextmanager
def fixture_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    server.counter_lock = threading.Lock()
    server.beacon_hits = 0
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


def run(browser_names=("chromium", "firefox")):
    from playwright.sync_api import sync_playwright

    result = {"schema": "filter-browser-fixture/v1",
              "surrogate": "Playwright route.abort; not a real blocker extension",
              "live_site_e2e": "NOT_RUN", "extension_loaded": False,
              "real_video_playback": "NOT_RUN",
              "browser_fixture": "FAIL", "browsers": []}
    with fixture_server() as server, sync_playwright() as playwright:
        target = f"http://127.0.0.1:{server.server_address[1]}/"
        for name in browser_names:
            browser = getattr(playwright, name).launch(headless=True)
            try:
                context = browser.new_context()
                page = context.new_page()
                page.goto(target, wait_until="load", timeout=30000)
                assert page.title() == "Synthetic filter compatibility fixture"
                before = server.beacon_hits
                assert page.evaluate("window.triggerBeacon('control')") == "loaded"
                assert server.beacon_hits == before + 1, "fixture positive control failed"
                context.route("**/beacon?*", lambda route: route.abort("blockedbyclient"))
                assert page.evaluate("window.triggerBeacon('blocked')") == "blocked"
                assert server.beacon_hits == before + 1, "surrogate route did not prevent beacon"
                page.locator("#user").fill("synthetic-user")
                page.locator("#sign-in").click()
                assert page.locator("#status").inner_text() == "login-ok"
                page.locator("#checkout").click()
                assert page.locator("#status").inner_text() == "checkout-ok"
                assert page.locator("video").count() == 1
                result["browsers"].append({
                    "engine": name,
                    "fixture_page": "PASS",
                    "synthetic_beacon_control": "PASS",
                    "surrogate_blocked_request": "PASS",
                    "synthetic_login_checkout": "PASS",
                    "real_extension": "NOT_RUN",
                    "real_site_e2e": "NOT_RUN"
                })
                context.close()
            finally:
                browser.close()
    result["browser_fixture"] = "PASS" if len(result["browsers"]) == len(browser_names) else "FAIL"
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=str)
    args = parser.parse_args()
    try:
        result = run()
    except Exception as exc:
        print("BROWSER FIXTURE FAILED:", type(exc).__name__, str(exc))
        return 1
    if args.report:
        with open(args.report, "w", encoding="utf-8") as output:
            json.dump(result, output, indent=2)
    print("BROWSER FIXTURE:", result["browser_fixture"], "-",
          len(result["browsers"]), "real browser engines, surrogate request blocking; "
          "NO real extension or production site verification")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
