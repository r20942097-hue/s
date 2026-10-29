"""Offline safety/unit tests for localhost-only browser render smoke.

No real browsers launched by these fixtures; real runner job is separate.
"""
import json
import struct
import zlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import browser_render_smoke as smoke

class BrowserSmokeTests(unittest.TestCase):
    def test_sandbox_relaxation_requires_explicit_opt_in(self):
        def runner(exe, url, workspace, unsandboxed_ephemeral=False):
            if unsandboxed_ephemeral:
                return {"result": "PASS", "sandbox": "DISABLED_LOCAL_FIXTURE_ONLY"}
            raise ValueError("CHROMIUM_EXIT_-6;stdout_bytes_0")
        with patch.object(smoke, "_chromium", side_effect=runner) as runner_mock:
            strict = smoke.inspect("chromium", discover=lambda name: name)
            self.assertEqual(strict["result"], "FAIL")
            self.assertEqual(runner_mock.call_count, 1)
        with patch.object(smoke, "_chromium", side_effect=runner) as runner_mock:
            partial = smoke.inspect("chromium", discover=lambda name: name,
                                    allow_no_sandbox_ephemeral=True)
            self.assertEqual(partial["result"], "PASS")
            self.assertEqual(partial["browser_checks"]["chromium"]["default_sandbox_attempt"],
                             "ABORTED_-6")
            self.assertEqual(runner_mock.call_count, 2)
            self.assertTrue(runner_mock.call_args_list[-1].kwargs["unsandboxed_ephemeral"])

    def test_unsandboxed_mode_not_enabled_for_arbitrary_failure(self):
        with patch.object(smoke, "_chromium",
                          side_effect=ValueError("CHROMIUM_DOM_MARKER_MISSING")) as run:
            result = smoke.inspect("chromium", discover=lambda name: name,
                                   allow_no_sandbox_ephemeral=True)
        self.assertEqual(result["result"], "FAIL")
        self.assertEqual(run.call_count, 1)

    def test_no_sandbox_command_not_default(self):
        process = subprocess.CompletedProcess([], 0, f'<div id="result">{smoke.MARKER}</div>'.encode(), b"")
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(smoke, "_run", return_value=process) as run:
                status = smoke._chromium("chromium", "http://127.0.0.1/fixture", Path(temp))
        self.assertNotIn("--no-sandbox", run.call_args.args[0])
        self.assertEqual(status["sandbox"], "DEFAULT")

    @staticmethod
    def valid_png():
        def chunk(kind, payload):
            return (struct.pack(">I", len(payload)) + kind + payload
                    + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF))
        ihdr = struct.pack(">IIBBBBB", 900, 600, 8, 2, 0, 0, 0)
        row = b"\x00" + b"\xff\xff\xff" * 900
        return (smoke.PNG_MAGIC + chunk(b"IHDR", ihdr)
                + chunk(b"IDAT", zlib.compress(row * 600))
                + chunk(b"IEND", b""))

    def test_script_marker_without_mutation_fails(self):
        body = f"<html><script>var text='{smoke.MARKER}'</script><div id='result'>NOT_READY</div></html>"
        command = subprocess.CompletedProcess([], 0, body.encode(), b"")
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(smoke, "_run", return_value=command):
                with self.assertRaises(ValueError):
                    smoke._chromium("chromium", "http://127.0.0.1/fixture", Path(temp))

    def test_png_corrupted_chunk_crc_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp)/"test.png"
            data = bytearray(self.valid_png())
            data[-1] ^= 1
            p.write_bytes(data)
            with self.assertRaises(ValueError):
                smoke._png_structure(p)

    def test_png_without_iend_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp)/"test.png"
            p.write_bytes(self.valid_png()[:-12])
            with self.assertRaises(ValueError):
                smoke._png_structure(p)

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
                   f'<html><div id="result">{smoke.MARKER}</div></html>'.encode(), b"")
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
            target.write_bytes(self.valid_png())
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
