# Run a Secretary evaluation

Use a development machine with Node 22.19 or newer, npm, Git, Python 3, and PostgreSQL 18 server tools. On macOS use a host with /usr/bin/sandbox-exec. Live evaluation uses the verified macOS target boundary. For offline fixtures on Linux use x86-64 or arm64 with Landlock ABI 4 or newer enabled. Obtain a recursive checkout, select the published revision you intend to test, and install its dependencies.

```sh
git clone --recurse-submodules --shallow-submodules https://github.com/ExplodeCode6324/secretary-benchmark.git
cd secretary-benchmark
git submodule update --init --recursive --depth 1
npm ci
node -v
python3 --version
pg_config --version
npm run benchmark -- evaluate --config examples/secretary-smoke.json
```

For a slow or interrupted upstream checkout, rerun the depth-limited submodule command. An operator with a local verified source mirror can use standard Git URL substitution for this command only. Provide the actual mirror locations in SUT_MIRROR and PI_MIRROR. The benchmark checks their commits and tracked state on every new run.

```sh
git -c protocol.file.allow=always \
  -c "url.file://$SUT_MIRROR.insteadOf=https://github.com/ExplodeCode6324/Secretary.git" \
  -c "url.file://$PI_MIRROR.insteadOf=https://github.com/earendil-works/pi.git" \
  submodule update --init --recursive --depth 1
```

On macOS with Homebrew, use `brew install postgresql@18` and add `$(brew --prefix postgresql@18)/bin` to PATH. Linux installations can use the PGDG postgresql-18 package. Work in a clean checkout outside any deployment instance. The operator creates a private PG cluster, delivers the setup and probe to the pinned Secretary, grades the observable answer and prints the run UUID, verdict and two report paths. A measured FAIL exits successfully. An incomplete or ungraded measurement exits with an error and retains its first failure. The smoke configuration uses scripted model responses. To exercise the real Secretary request builder and local mock SSE endpoint, substitute `examples/secretary-wire.json`. Both configurations work offline after installation.

## Score an ordered workload against reference answers

Run the public offline example with one command:

```sh
npm run benchmark -- evaluate --config examples/secretary-questions.json
```

Keep the question-series v2 configuration on the controller. The case-package version is 1. Put information and questions in `timeline` in the order Secretary should receive them. Use a unique `id` for each question. Write its `reference.required` and `reference.forbidden` facts as they stood when the question was asked. Set the abstention policy to REQUIRED, ACCEPTABLE or NOT_ACCEPTABLE. The controller delivers only each event's text through Secretary's normal messages endpoint. It retains the full observed reply from the corresponding handled loop and stores other output separately.

The public example uses scripted model transport and a fixture judge. For a live series on supported macOS, configure credentials and pinned Hermes as described below. Copy the example to a private controller location, select workload `opencode-go`, judge `hermes-go`, billing policy `record-only` and an appropriate per-send timeout. A live run sends the selected event data to the worker and the question, standard facts and recorded answer to the judge. The workload call limit is `timeline.length × workloadCallsPerEvent`. Choose `maxJudgeCalls` for both the original and any diagnostic regrade; each grade includes its own qualification. The operator refuses an insufficient allowance before sending a scoring packet.

The fixed [factual grading prompt](../test_case/online/benchmark/operator/fact-grading-v1.txt) applies to every series packet. A packet contains only its included questions, each question’s own versioned reference and recorded answer. `questionsPerRequest` defaults to the value in the example; set it to 1 for single-question requests or up to 12 to batch. The controller may split sooner to fit the input bytes and number of facts qualified by the preregistered controls. Each packet gets a fresh, tool-free reader session. The controller freezes packet membership and reference/answer digests before dispatch. It accepts each expected question and fact ID exactly once and records the first response. An oversized item or invalid reply stays in the report. Failed packets are never retried automatically.

| Host outcome | Interpretation |
| --- | --- |
| PASS | All required facts are supported or the answer explicitly abstains where permitted. |
| PARTIAL | At least one required fact is supported and the remaining required facts are absent. |
| FAIL | A required fact is contradicted, a forbidden claim is asserted, abstention violates policy, or no required fact is supported. These conditions take precedence over partial credit. |
| MISSING | A handled question received no visible answer. |
| JUDGE_FAILED | The report records the oversize, calibration, transport or validation failure, or an unsent packet. |
| NOT_EXECUTED | The question has no confirmed delivery and observation. |

An acknowledged refusal is an answer and is judged under its question’s abstention policy. Reports retain the full planned denominator and original order. Each grade records its account claim snapshot when available. A timed-out event stops further input; already acknowledged questions remain eligible. Use `recover-run` for an interrupted controller and `regrade` for an explicit diagnostic from the sealed evidence. Open `grades/original/plan.json` for packet membership and `grades/original/packets/N/input.json` for the exact question packet and rendered prompt. During a live grade the sister `wire.json` records the native request. The original C04 example below uses the historical access-and-visibility rubric.

## Live evaluation

The live example runs one public synthetic C04-resident case. The worker receives the Elm token in the first event and is asked for it in the second. The selected workload profile uses Secretary with OpenCode Go DeepSeek V4.1 Flash at low reasoning. The independent native Hermes reader uses the same published model at max reasoning and a fixed versioned prompt. It calibrates on 28 labels and a known-good and known-bad answer before grading the actual reply. Inspect the count, first answer, judgement and citations in the private run bundle. A resident-use result covers one assertion in one case.

Point the following variables to the pinned Hermes source checkout and its installed Python environment. For a clean installation, obtain the source and install the dependencies into a dedicated virtual environment. An existing installation at the specified revision can use its own dependency interpreter. Use its interpreter path under the venv, including the final bin/python component.

```sh
git clone https://github.com/NousResearch/hermes-agent.git /path/to/hermes-agent
git -C /path/to/hermes-agent checkout --detach 97a9ae8ee55d31bebce49f1fb6b5ef775323976a
export BENCHMARK_HERMES_ROOT=/path/to/hermes-agent
UV_PROJECT_ENVIRONMENT=/path/to/reader-venv uv sync --directory "$BENCHMARK_HERMES_ROOT" --frozen --python 3.14 --no-dev
export BENCHMARK_HERMES_PYTHON=/path/to/reader-venv/bin/python
git -C "$BENCHMARK_HERMES_ROOT" rev-parse HEAD
npm run benchmark -- reader-check --run RUN_UUID
```

Replace RUN_UUID with the UUID printed by the smoke run. Reader-check makes one native Hermes turn with simulated transport and prints its source revision, wire hash and external call count. Every grading turn gets a fresh home, no tools, no fallback and one native call. The controller sends the validated wire to the fixed endpoint. For workload calls it forwards the session ID produced by the pinned Pi runtime and Secretary’s own user agent. The wire rehearsal checks these headers before dispatch. [OpenCode Go client requirements](https://opencode.ai/docs/console/go/#where-can-i-use-it)

Supply references to existing owner-only credential files (mode 0600). Each file uses one `NAME=value` line for the referenced variable. The controller reads only the selected field. Two references can point to a single authorized subscription for which the operator maintains a shared ledger. Once configured, keep the account directory across checkouts and attempts.

```sh
export SECRETARY_BENCHMARK_GO_FILE=/private/path/to/workload.env
export SECRETARY_BENCHMARK_GO_VARIABLE=OPENCODE_GO_API_KEY
export SECRETARY_BENCHMARK_JUDGE_FILE=/private/path/to/reader.env
export SECRETARY_BENCHMARK_JUDGE_VARIABLE=OPENCODE_GO_API_KEY
export BENCHMARK_OPERATOR_ACCOUNT=/private/path/to/shared-account-ledger
npm run benchmark -- evaluate --config examples/secretary-live.json
```

One invocation runs the public case, calibration, independent grading and report. The example uses `record-only` billing. It records reported usage, list price and cash charges. Missing fields appear as unknown. Only an actual provider quota rejection is reported as a quota limit. The 12 workload and five judge request limits describe the experiment, and each send has a 900-second timeout. Each frozen configuration can start the target once. To run another measurement, copy the config to .local and set its `cohort` to a new lowercase identifier. Keep the previous run, its UUID and first failure in the measurement history. Use `regrade` for a judge-only diagnostic on the existing execution. The optional `freeze` command prints the exact config and published model.

The operator rubric `issue122-operator-reader-go-v2` applies one fixed procedure to identify the requested value from the first request and classify coverage. The controller seals the 28 private expected labels before dispatch, sends only the blind controls, and records each returned label beside its expected value locally. Qualification requires all 28 correct and both case-shaped discrimination controls. These are development-visible templates. The v2 clarification followed a missed v1 visibility control on the same templates. The calibration measures performance on these known controls. Generalization to held-out inputs and broader memory quality require separate measurements. The historical R79 policy and its results keep their original version.

If a controller was interrupted during an execution, use `npm run benchmark -- recover-run --run RUN_UUID` to verify and stop its own PG cluster and retain the incomplete result. Raw bundles and reports belong in private operator storage.

### Historical bounded runs

For an older live profile without a billingPolicy field or one explicitly using `"billingPolicy": "bounded"`, use `freeze` and set BENCHMARK_APPROVAL to the approved digest before evaluation. Set BENCHMARK_PRIOR_EXPOSURE_USD to any earlier unsettled exposure. These profiles retain their original settlement rules. Match the original request UUID, run, freeze and wire digest in the private transport records to the account ledger. Inspect the first HTTP record and raw provider bytes if available. Identity-only holds close the affected run when billing is verified. Financial or transport holds apply to the shared account. If the account owner elects to retain the entire request ceiling as unresolved, create a private JSON statement with attempt, run, freeze, wireDigest, disposition (`retain-full-ceiling`) and basis (the evidence reviewed). Approve the SHA-256 of those exact bytes, then run `npm run benchmark -- reconcile-call --run RUN_UUID --attempt REQUEST_UUID --evidence STATEMENT_FILE --approval STATEMENT_SHA256`. For a regrade from a portable copy use `--bundle "$BUNDLE"` in place of `--run RUN_UUID`. Keep the original execution UUID in the statement. The tool verifies the bundle and its local transport evidence against the shared ledger. The command appends the disposition, keeps the full exposure in the account and closes that freeze. It never resends the request or assigns the unknown cash amount a value. Any subsequent live cohort has its own approval.

## Verify and replay

Use a fresh private directory for each export. The export contains sealed execution evidence, events, grading records and request receipts. Reports are generated from these inputs. The export prints the SHA-256 of bundle.json for transfer verification. It can be moved to a second clean checkout at the same commit. Save the original report bytes or their hashes before regrading. Regrading uses the same authorized judge and a fresh session. It reuses a compatible calibration for up to 24 hours. After expiry it requires four remaining authorized judge calls to calibrate, check both controls and score again. Each regrade appends a diagnostic grade with a new UUID and preserves the original. The offline render reads the chosen grade without launching the target or reader. Use cmp on both report files.

```sh
RUN=RUN_UUID
BUNDLE="$PWD/.local/portable-$RUN"
npm run benchmark -- export-run --run "$RUN" --output "$BUNDLE"
BENCHMARK_DISABLE_TARGET=1 npm run benchmark -- regrade --bundle "$BUNDLE"
BENCHMARK_DISABLE_TARGET=1 BENCHMARK_DISABLE_JUDGE=1 npm run benchmark -- report --bundle "$BUNDLE" --grade original --output "$PWD/.local/rebuilt-$RUN"
cmp ".local/benchmark/$RUN/reports/report.json" ".local/rebuilt-$RUN/report.json"
cmp ".local/benchmark/$RUN/reports/report.md" ".local/rebuilt-$RUN/report.md"
npm run benchmark -- compare --run "$RUN" --reference "$BUNDLE"
```

The printed diagnostic grade UUID can replace original to render its report. Compare validates the imported bundle and prints both original verdicts and contract compatibility. Each live request must match its frozen serving identity. Keep unverified cross-system comparisons separate.

To archive a stopped original facility, configure the existing ignored .local/archive.json with the mount and destination on a mounted private volume (mode 0600). Preview with `npm run benchmark -- archive-run --run "$RUN"`. To publish the verified full archive and release the owned source, add `--apply true`. The archive retains the private PG state, failures and all raw data. Keep portable copies and their diagnostic grades in private storage as well.

## Target protocol v1

The controller launches the target process in an empty owned work directory behind an OS filesystem boundary. Requests and responses are one JSON object per line on standard input/output. Diagnostic logs use standard error. A request contains protocol (1), id, command and data. A success response echoes protocol and id and supplies result. An error echoes both fields and supplies error. Capabilities lists supported commands. Start initializes isolated storage and proves access to the positive control plus denial of the direct and aliased private files. Deliver accepts one id, sequence and text through the normal system input. Observe returns the acknowledged inputId, sequence, replies, model-call evidence and effects. Export returns the ordered observations. Stop flushes and closes the owned process. The reference process is test_case/online/benchmark/operator/target.ts. Native ProkBot and stock pi plus pi-hermes-memory may implement the protocol separately. Native target runs and comparison alignment belong to item 3.
