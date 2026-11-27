# Secretary Benchmark

For an ordered multi-question workload with factual reference answers, run `npm run benchmark -- evaluate --config examples/secretary-questions.json`. The [operator guide](docs/operator.md) explains the per-question results, configurable packet sizes and offline replay.

Run one configured evaluation with `npm run benchmark -- evaluate --config examples/secretary-smoke.json`. For the live DeepSeek workload, fixed-prompt Hermes judge, portable regrade and offline report, follow the [operator guide](docs/operator.md).

A separately versioned benchmark harness for [Secretary](https://github.com/ExplodeCode6324/Secretary). It owns isolated test facilities, immutable grading receipts, fixed-input replay and coverage reports. The Secretary SUT is pinned in `sut.lock.json` and checked out recursively under `sut/secretary`.

**Scope:** runnable benchmark, traceable evidence and reproducible reports. Results are advisory and not human-qualified; this release does not qualify Secretary memory performance or set acceptance thresholds.

## Reproduce correctness checks

Requirements: Node.js 22.19+, npm, Python 3, Git, PostgreSQL **18 server tools** (`initdb`, `pg_ctl`, `psql`) on PATH. Tests create their own isolated clusters; no API credentials or deployed Secretary instance are required. Run as a regular user, not root.

```sh
git clone --recurse-submodules https://github.com/ExplodeCode6324/secretary-benchmark.git
cd secretary-benchmark
npm ci
npm run verify
```

`npm run benchmark -- ...` is the sole harness entry point. See [operations](test_case/online/benchmark/README.md). Use explicit facility roots under this repository's `.local/benchmark/`. Do not run this from a deployment checkout. The protected agile checkout and path aliases are rejected. There are no start/stop deployment scripts in this package.

The SUT dependency must match the Git link and lock, including recursive submodules, and contain no tracked or untracked source changes. Only the differential regression tests import the SUT's historical harness. Production benchmark execution uses this repository's harness. Differential tests create ignored runtime fixtures under `sut/secretary/.local/`; Python helpers may create ignored bytecode caches. The source pin stays unchanged. These nested fixtures are included in verified archival and local-retention receipts. Updating the SUT pin is a separate reviewed change.

## Evidence and limits

[Evidence index](evidence/README.md) separates historical delivery facts from the first standalone correctness validation. Historic private inputs are not published; retained hashes are traceability receipts, not a claim that the private pilot can be reproduced from this public tree. Historical SUT identities and the first-pilot projection were recovered from verified private sources after safe-network access resumed; see `evidence/first-pilot-validation.json`. The initial execution snapshot (31 leaf rows), resource audit (50 rows / 563 physical-send reservations) and final Opus selection (30 original trajectories / 28 eligible) remain separate snapshots. The current SUT pin is never substituted for a historical run identity.

Opus 5.5 Extra is the current judge policy. Frozen Fable v3 history remains immutable and distinct. Static controls are development-visible synthetic fixtures; they are not hidden held-out qualification. The public QA path changes the upstream judge/parser and is not an official LongMemEval score. No live model requests are made by correctness CI.

Archive targets have **no default**. Configure `mount` and `destination` as absolute paths in ignored `.local/archive.json` (owner-only mode 0600). The existing external-mount, ownership, stopped-facility and verified-copy guards still apply. Do not create a local substitute for a missing external mount. Validation data is retained until verified archival; see the archival status in the work receipt.

## Provenance and licensing

Extracted from Secretary PR [#134](https://github.com/ExplodeCode6324/Secretary/pull/134), reviewed head `50ffe5dd0ec50c89bb9421c38a7827bc75dc799a`, merged as `873b66f4b906ff53a62476ff5dd1466649c427f7`. The merge changed no benchmark files. Secretary's old copy remains historical compatibility code; future benchmark development belongs here.

No additional software license has been selected or granted for this repository. Public visibility is not a license grant. Third-party components retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).

[中文说明](README.zh-CN.md) · [reviewed extraction plan](docs/fix/standalone-publication.en.md)

If the operating system cannot resolve the current account in its password database (for example, a container UID with no entry), protected-checkout verification fails closed; provide a normal account entry before running the harness.

### Issue 122 cross-batch results

Before archiving each stopped facility, finish the authorized assessments and capture the output of `baseline-stage-c-results --root <facility> --sha256 <freeze digest>` using the exact runner that produced the batch. Save that output as `reports/stage-c-results.json` in the facility. Check the command exited successfully and the JSON has `batch_closed: true` before archiving. Treat this export as immutable. Retain the verified archive receipt.

For `baseline-stage-c-combine --root <aggregate>`, create `inputs/stage-c-batch-index.json` under the aggregate root with a `batches` array. Each entry has `archive_day` (YYYYMMDD), `archive_id`, `archive_sha256`, `freeze_sha256` and `decisions` with the workload and, if any calibration or assessment was started, its separate grading decision reference. Under `inputs/batches/<freeze_sha256>/` supply the exact bytes of the archived freeze, projection and results as `stage-c-freeze.json`, `stage-c-projection.json` and `stage-c-results.json`. When the last calibration attempt has a result, include the corresponding archived `oracles/completion/calibration/attempt-N-result.json` as `calibration-result.json`. Keep these files private.

The command reads the archive from the configured external mount, verifies the archive, receipt and file inventory, and checks each export against that inventory. Its output counts shared attempts once and retains missing observations in each family's denominator. Closed workload results can include incomplete trials or outstanding assessments. Record these outcomes when interpreting the baseline.

For subsequent Issue 122 live assessments run `baseline-stage-c-controls --root <facility> --reader Hermes/deepseek/deepseek-flash/max` before freezing. Use the exact frozen model, official provider, wire effort and a fresh independent Hermes session for each authorized packet. Record the genuine model response, transport metadata and usage. The original Opus controls remain readable for existing freezes. Each new batch retains its own randomized controls and answer key.

The first C04 workload predates the reader change. Retain its original result export and original freeze. For that batch, include the separately authorized decision digest as `grading_amendment_sha256` in the batch index and copy the archived `reports/reader-deepseek-v1/` assessment, rubric, decision, calibration packet/receipt, and transport/query into the same relative subdirectory (`reader-deepseek-v1/`) of its private export folder. Supply the two original controls files from `oracles/completion/calibration/` as `reader-deepseek-v1/original-controls.json` and `reader-deepseek-v1/private-key.json`. The importer checks archive hashes, replays calibration against those controls, and preserves the ungraded C04 observation. It preserves the original workload freeze alongside the amended reader identity.

For the prospective visibility rubric, add `--rubric issue122-comparison-reader-v2` to the official Hermes controls command. Each packet has one attempt. The begin command returns the exact query. Submit the native dispatch, transport and exact final UTF-8 text to finish in JSON fields `dispatch`, `transport` and `raw`. Keep the private key on the host. Use `c16_dedicated_batch: true` in live preflight to place only the three C16 repeats in batch 2. Record the approval and resulting calibration disposition in the dispatch sheet.

The current batch-1 aggregate index includes a `reader_recovery` object with the scoring supplement’s archive day, ID and SHA-256. Combine verifies the original and recovery archives and recalculates the two fees and the 26/27 outcome. To reproduce the snapshot before recovery, omit that reference and set `grading_as_of` to `first-official-attempt`. A failed earlier calibration with zero graded candidates remains explicitly attributed to its original rubric when combined with v2.
