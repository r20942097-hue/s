# GPT1 | GitHub repository environment preflight

This repo has a **read-only, offline** structural preflight. It is supplementary to existing filter/runtime CI; it is **not** evidence of full browser, Windows device, authenticated site, recording, or release acceptance.

## Run locally

```sh
python scripts/gpt1_preflight.py --json
python -m unittest discover -s tests -p test_gpt1_preflight.py -v
```

**v1.1 fail-closed semantics:** missing Git metadata is `PARTIAL` (exit 2) when running locally and `FAIL` (exit 1) under `--require-git`. Invalid file/directory types, symbolic links, malformed state, non-string repository IDs and ambiguous governance values are rejected. CI invokes `--expected-repository r20942097-hue/s --require-git`. Only a fully evaluated structural audit is `PASS` (exit 0). Product E2E and publishing checks always remain `NOT_RUN` under this utility.

Requires Python 3.11+. The script checks `ai/PROJECT_STATE.json`, baseline repository files, the P0 / PUBLICATION_HOLD / NO_NEW_INTERNAL_PUSH governance gate, and (in Git checkouts) tracked ZIP/7z archives. Missing Git metadata produces **NOT_RUN**, never a false success.

PR CI runs Python 3.11 / 3.14 on Ubuntu and Windows. Actions are pinned to complete commit hashes, use read-only `contents` permissions and do not persist checkout credentials. The PR event has no path filter, so its checks are not left pending on documentation-only PRs.

## Boundaries

- `faaff` is the engineering/integration hub. Its `main` does **not** contain the complete Watcher runtime; a green preflight does not claim those tests ran.
- `s` is the canonical subscription repository; its stable filter paths and generated lists are not modified by preflight.
- `s` changes must be merged and then re-imported into `faaff` by a separate provenance-verified PR. A proposed PR branch is not an accepted release or pinned import.
- Do not add release archives, secrets, browser profiles, credentials, recordings, or diagnostic logs to Git.
- Keep the protected `main` branch and PUBLICATION_HOLD intact. This proposal does not merge, publish, or alter repository visibility.

Output status vocabulary: PASS / FAIL / PARTIAL / NOT_RUN. CLI exits 0 = structural PASS, 1 = FAIL, 2 = PARTIAL. A structural PASS is **not** end-to-end acceptance.
