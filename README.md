# Secretary Benchmark

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

The SUT dependency must match the Git link and lock, including recursive submodules, and contain no tracked or untracked source changes. Only the differential regression tests import the SUT's historical harness. Production benchmark execution uses this repository's harness. Differential tests create ignored runtime fixtures under `sut/secretary/.local/`; Python helpers may create ignored bytecode caches. The source pin stays unchanged. These nested local fixtures are included in the deferred local-retention scope. Updating the SUT pin is a separate reviewed change.

## Evidence and limits

[Evidence index](evidence/README.md) separates historical delivery facts from the first standalone correctness validation. Historic private inputs are not published; retained hashes are traceability receipts, not a claim that the private pilot can be reproduced from this public tree. Historical SUT identities and the first-pilot projection were recovered from verified private sources after safe-network access resumed; see `evidence/first-pilot-validation.json`. The initial execution snapshot (31 leaf rows), resource audit (50 rows / 563 physical-send reservations) and final Opus selection (30 original trajectories / 28 eligible) remain separate snapshots. The current SUT pin is never substituted for a historical run identity.

Opus 5.5 Extra is the current judge policy. Frozen Fable v3 history remains immutable and distinct. Static controls are development-visible synthetic fixtures; they are not hidden held-out qualification. The public QA path changes the upstream judge/parser and is not an official LongMemEval score. No live model requests are made by correctness CI.

Archive targets have **no default**. Configure `mount` and `destination` as absolute paths in ignored `.local/archive.json` (owner-only mode 0600). The existing external-mount, ownership, stopped-facility and verified-copy guards still apply. Do not create a local substitute for a missing external mount. Validation data is retained until verified archival; see the archival status in the work receipt.

## Provenance and licensing

Extracted from Secretary PR [#134](https://github.com/ExplodeCode6324/Secretary/pull/134), reviewed head `50ffe5dd0ec50c89bb9421c38a7827bc75dc799a`, merged as `873b66f4b906ff53a62476ff5dd1466649c427f7`. The merge changed no benchmark files. Secretary's old copy remains historical compatibility code; future benchmark development belongs here.

No additional software license has been selected or granted for this repository. Public visibility is not a license grant. Third-party components retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).

[中文说明](README.zh-CN.md) · [reviewed extraction plan](docs/fix/standalone-publication.en.md)
