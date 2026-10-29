"""Offline safety/unit tests for localhost-only browser render smoke.

No real browsers launched by these fixtures; real runner job is separate.
"""
import json
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import browser_render_smoke as smoke

class BrowserSmokeTests(unittest.TestCase):
    def test_html_has_script_marker(self):
        self.assertIn(smoke.MARKER.encode(), smoke.HTML)
        self.assertIn(b"<script>", smoke.HTML)

    def test_known_png_signature(self):
        self.assertEqual(smoke.PNG_MAGIC, b"\x89PNG\r\n\x1a\n")

    def test_missing_both_browsers_is_failure(self):
        x = smoke.inspect("both", discover=lambda name: None)
        self.assertEqual(x["result"], "FAIL")
        self.assertEqual(set(x["browser_checks"]), {"chromium", "firefox"})

    def test_missing_browser_not_misreported_pass(self):
        x = smoke.inspect("firefox", discover=lambda name: None)
        self.assertEqual(x["browser_checks"]["firefox"]["result"], "FAIL")

    def test_unknown_browser_is_rejected(self):
        with self.assertRaises(ValueError):
            smoke.inspect("malicious")

    def test_chromium_dom_success_fixture(self):
        command = subprocess.CompletedProcess([], 0,
                   ("<html>" + smoke.MARKER + "</html>").encode(), b"")
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(smoke, "_run", return_value=command) as run:
                response = smoke._chromium("chromium", "http://127.0.0.1/fixture", Path(temp))
        self.assertEqual(response["result"], "PASS")
        argv = run.call_args.args[0]
        self.assertIn("--disable-extensions", argv)
        self.assertIn("--dump-dom", argv)

    def test_chromium_without_js_marker_fails(self):
        command = subprocess.CompletedProcess([], 0, b"<html>NOT_READY</html>", b"")
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(smoke, "_run", return_value=command):
                with self.assertRaises(ValueError):
                    smoke._chromium("chromium", "http://127.0.0.1/fixture", Path(temp))

    def test_chromium_nonzero_fails(self):
        command = subprocess.CompletedProcess([], 1, smoke.MARKER.encode(), b"error")
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(smoke, "_run", return_value=command):
                with self.assertRaises(ValueError):
                    smoke._chromium("chromium", "http://127.0.0.1/fixture", Path(temp))

    def test_firefox_valid_screenshot(self):
        def write_file(argv, timeout):
            target = Path(argv[argv.index("--screenshot")+1])
            target.write_bytes(smoke.PNG_MAGIC + b"\0" * 8
                               + struct.pack(">II", 900, 600) + b"0"*1100)
            return subprocess.CompletedProcess([], 0, b"", b"")
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(smoke, "_run", side_effect=write_file):
                r=smoke._firefox("firefox", "http://127.0.0.1/fixture", Path(temp))
        self.assertEqual(r["png_dimensions"], [900, 600])

    def test_firefox_missing_screenshot_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(smoke, "_run", return_value=subprocess.CompletedProcess([],0,b"",b"")):
                with self.assertRaises(ValueError):
                    smoke._firefox("firefox", "http://127.0.0.1/fixture", Path(temp))

    def test_firefox_invalid_png_fails(self):
        def write_file(argv, timeout):
            Path(argv[argv.index("--screenshot")+1]).write_bytes(b"not-an-image")
            return subprocess.CompletedProcess([], 0, b"", b"")
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(smoke, "_run", side_effect=write_file):
                with self.assertRaises(ValueError):
                    smoke._firefox("firefox", "http://127.0.0.1/fixture", Path(temp))

    def test_firefox_timeout_is_fail_not_pass(self):
        with patch.object(smoke, "_firefox", side_effect=subprocess.TimeoutExpired("firefox", 65)):
            result = smoke.inspect("firefox", discover=lambda cmd: cmd)
        self.assertEqual(result["result"], "FAIL")
        self.assertEqual(result["release_decision"], "CANDIDATE_NO_GO")

    def test_inspect_mock_both_success(self):
        with patch.object(smoke, "_chromium", return_value={"result":"PASS"}):
            with patch.object(smoke, "_firefox", return_value={"result":"PASS"}):
                r = smoke.inspect("both", discover=lambda cmd:cmd)
        self.assertEqual(r["result"], "PASS")
        self.assertEqual(r["extension_install"], "NOT_RUN")
        self.assertEqual(r["live_product_e2e"], "NOT_RUN")

    def test_cli_failure_exit_code(self):
        with patch.object(smoke, "inspect", return_value={"result":"FAIL","browser_checks":{}}):
            with patch("builtins.print"):
                self.assertEqual(smoke.main(["--browser", "both", "--json"]), 1)

    def test_cli_success_exit_code(self):
        with patch.object(smoke, "inspect", return_value={"result":"PASS","browser_checks":{}}):
            with patch("builtins.print"):
                self.assertEqual(smoke.main(["--browser", "both", "--json"]), 0)

    def test_json_serialisable(self):
        json.dumps(smoke.inspect("chromium", discover=lambda name:None))


if __name__ == "__main__":
    unittest.main()
