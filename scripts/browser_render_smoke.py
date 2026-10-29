"""Run isolated local-only browser render smoke checks with zero extra dependencies.

Tests a synthetic HTTP page, not user extensions or external sites. Uses short
timeouts and disposable browser profiles. A PASS never approves a product.
"""
from __future__ import annotations

import argparse
import json
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MARKER = "GPT1_BROWSER_JS_RENDER_OK_2026"
HTML = ("""<!doctype html><html lang="en"><meta charset="utf-8">"""
        """<title>Isolated Browser Test</title>"""
        """<body style="background:#fff;color:#111;font-size:32px">"""
        """<h1>Isolated rendering fixture</h1><div id="result">NOT_READY</div>"""
        """<script>document.getElementById('result').textContent='"""
        + MARKER + """';</script></body></html>""").encode("utf-8")
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
MAX_OUTPUT = 2 * 1024 * 1024


class LocalHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/fixture":
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(HTML)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(HTML)

    def log_message(self, format, *args):
        return


def _run(args: list[str], timeout: int = 65) -> subprocess.CompletedProcess:
    result = subprocess.run(args, capture_output=True, timeout=timeout,
                            check=False)
    if len(result.stdout) > MAX_OUTPUT:
        raise ValueError("browser stdout exceeded limit")
    return result


def _chromium(executable: str, url: str, workspace: Path) -> dict:
    profile = workspace / "chromium-profile"
    result = _run([executable, "--headless", "--disable-gpu", "--no-first-run",
                   "--no-default-browser-check", "--disable-background-networking",
                   "--disable-extensions", "--user-data-dir=" + str(profile),
                   "--virtual-time-budget=2000", "--dump-dom", url], timeout=55)
    text = result.stdout.decode("utf-8", "replace")
    if result.returncode != 0:
        # Fixed-category diagnostics only; no raw stderr, URL or profile path.
        err = result.stderr.decode("utf-8", "replace").lower()
        categories = [category for category in ("sandbox", "namespace", "zygote",
                      "crashpad", "dbus", "gpu", "permission", "profile",
                      "fatal", "check failed", "root", "resource",
                      "cannot", "failed", "error") if category in err]
        raise ValueError(f"CHROMIUM_EXIT_{result.returncode};stdout_bytes_{len(result.stdout)};"
                         f"stderr_bytes_{len(result.stderr)};categories_{','.join(categories)}")
    if MARKER not in text:
        raise ValueError(f"CHROMIUM_DOM_MARKER_MISSING;stdout_bytes_{len(result.stdout)};"
                         f"html_seen_{'<html' in text.lower()}")
    return {"result": "PASS", "javascript_marker": "FOUND", "dom_bytes": len(result.stdout)}


def _firefox(executable: str, url: str, workspace: Path) -> dict:
    profile = workspace / "firefox-profile"
    profile.mkdir()
    image = workspace / "firefox-canary.png"
    result = _run([executable, "-no-remote", "-profile", str(profile),
                   "--headless", "--window-size", "900,600",
                   "--screenshot", str(image), url], timeout=65)
    if result.returncode != 0 or not image.is_file():
        raise ValueError("Firefox headless did not write screenshot")
    with image.open("rb") as handle:
        header = handle.read(24)
    if len(header) != 24 or not header.startswith(PNG_MAGIC):
        raise ValueError("Firefox screenshot is not PNG")
    width, height = struct.unpack(">II", header[16:24])
    if not (600 <= width <= 2400 and 400 <= height <= 2400):
        raise ValueError("Firefox screenshot dimensions outside expected range")
    if image.stat().st_size < 1000:
        raise ValueError("Firefox screenshot unexpectedly small")
    return {"result": "PASS", "png_dimensions": [width, height],
            "screenshot_bytes": image.stat().st_size}


def inspect(browser: str = "both", discover=shutil.which) -> dict:
    if browser not in {"both", "chromium", "firefox"}:
        raise ValueError("unknown browser")
    requested = ["chromium", "firefox"] if browser == "both" else [browser]
    observations: dict[str, dict] = {}
    with tempfile.TemporaryDirectory(prefix="gpt1-browser-smoke-") as temp:
        workspace = Path(temp)
        server = ThreadingHTTPServer(("127.0.0.1", 0), LocalHandler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{server.server_port}/fixture"
        try:
            for name in requested:
                executable = discover(name)
                if not executable:
                    observations[name] = {"result": "FAIL", "reason": "not found on PATH"}
                    continue
                try:
                    observations[name] = (_chromium(executable, url, workspace)
                                          if name == "chromium"
                                          else _firefox(executable, url, workspace))
                except (OSError, ValueError, UnicodeError,
                        subprocess.TimeoutExpired) as exc:
                    reason = (str(exc) if type(exc) is ValueError else "RUNTIME_EXECUTION_FAILURE")
                    observations[name] = {"result": "FAIL", "reason": reason}
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
    passed = len(observations) == len(requested) and all(
        record["result"] == "PASS" for record in observations.values()
    )
    return {"schema": "gpt1-isolated-browser-render/v1",
            "result": "PASS" if passed else "FAIL",
            "fixture": "localhost synthetic document; no external URLs",
            "browser_checks": observations,
            "extension_install": "NOT_RUN", "service_worker": "NOT_RUN",
            "live_product_e2e": "NOT_RUN", "release_decision": "CANDIDATE_NO_GO"}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", choices=["both", "chromium", "firefox"],
                        default="both")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    result = inspect(args.browser)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(result["result"], result["browser_checks"])
    return 0 if result["result"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
