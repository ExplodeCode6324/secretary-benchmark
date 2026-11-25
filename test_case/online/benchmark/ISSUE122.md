# Issue #122 Stage A — offline contracts

[Approved bilingual plan](https://github.com/ExplodeCode6324/Secretary/blob/codex/issue122-memory-baseline/docs/fix/fix_20261118_issue122_memory_baseline.en.md).
Stage A implements offline preparation and evidence contracts. It does not dispatch the new live matrix. No result here qualifies Secretary or authorizes spending, RC98304, a model substitution, or merge.

```sh
npm run benchmark -- baseline-plan
npm run benchmark -- baseline-prepare --root "$PWD/.local/benchmark/issue122-preflight-UNIQUE"
npm run verify
```

`baseline-plan` prints the expanded synthetic dev manifest and pending decisions without starting a worker. `baseline-prepare` starts one owned **fixture** worker and PG, collects real product prompt/budget configuration for three model descriptors at DEP default and the RC98304 candidate, emits a per-case forecast, then stops/seals the domain. Its fetch blocks network. Model descriptors are offline registry entries, not online availability verification. Archive the stopped facility through the existing `benchmark archive` workflow after retaining its report and receipt.

## Six review conditions

- **S1:** `baselinePair` uses the existing source-A / exactly-one-restore-B lifecycle. Both probes follow restart. Quiescence includes the product's actual `memoryDue()` value, maintenance promise, pending summary and all pending extraction/model work. Before checkpoint and either probe all handled turns must be covered; the covered sequence and Consciousness revision must match at A and B. A cannot create a Task, uncertain/partial/applied mutation or non-terminal operation or changed sink; its failure remains evidence and B stays unexercised. Restore never resets campaign accounting. Initialize the source's payload guard before setup; future-input lists must be frozen by the eventual live driver.
- **S2:** maintenance matches B's `main.message` source ID and its handled sequence, since the product does not put `input.handled` marker IDs into `source_event_ids`. A committed non-CONTEXT_COMPACTION cycle is required. Deadline outcomes distinguish absent trigger, running, stale-discarded, retry-pending failure and terminal failure, preserving every failed attempt. The forecast uses normal 8-turn/60-second/120-second timing, with the source's critical-feedback exception, and reports opportunities rather than achieved exit or coverage.
- **S3:** route metadata separates product UNSUPPORTED from #120 HARNESS_EXCLUDED. Real fixture coverage exercises an owned note, RESOURCE_PRESENT waiting, scripted file creation, Task `read`, and `submit_result`, without a model write. That proves the route, not source-authority semantics of a live model. Note-file hashes/read receipts and Task interpretations remain separate oracle sources. `baseline-timeline.ts` now gives each route explicit host actions, Master bodies, hashed scripted note content and real Task/feedback boundaries; exact observed IDs/revisions/display hashes still bind at live freeze. Named API route shapes are plans, not proof that the unimplemented live driver works.
- **S4:** [source inspection](../../../evidence/issue122-reuse-audit.json) retains the three-model lifecycle-v2 same-operation chain and one-write observation. It lacks a separately persisted contemporaneous old-process exit witness: C12b is required. New process witnesses query the owned OS identity and retain immutable STOPPED/RUNNING receipts. A hash-only evidence inventory reports identity review still required; it never claims all interruption semantics passed. Restart exports distinguish direct same-domain and checkpoint restore.
- **S5:** three necessary archives were streamed read-only through the existing verifier, including all file hashes/sizes; no SUT, historical controller or PG was started. Access is logged privately. Only small synthetic evidence selections entered quarantine; private-A packet integrity inspection yielded sanitized metadata only. Other historical rows remain report-only, with no regrading or altered labels.
- **S6:** optional `issue122-budget-v1` policy extends the existing durable campaign, bounding model/lane/aggregate USD and reservations, preserving unknown-usage charges across descendants, rejecting lineage rebinding and checking full-lane headroom at admission. Static disjoint lane allocations protect that allowance across concurrent lanes. Connectivity has at most three reservations per model. Frozen rates and billed-output bounds are required; reasoning uses a verified maximum if the requested cap is not a verified bound. The send guard applies frozen rates both to reservations and settlement. Its wall-clock dispatch windows are conservatively stricter than active time; offline/archive/review work precedes dispatch. Any above-reservation settlement records a bound violation in the durable ledger and blocks all later baseline dispatch. No policy has been approved for real use.

## Semantic extension and evidence limits

`secretary-issue122-semantic-v1` separates natural access, current/history, maintenance-current, use-current, authority, text survival, item lineage, obligations, effects and source identity. A grade is bound to the exact case/packet and expected assertions; PASS/FAIL require hash-verified evidence references. Unsupported capability, harness exclusion and deferred time are manifest classifications, not semantic success. Missing stable item identities remain NOT_TESTED. Cold proof requires all four actual request surfaces absent, no opaque state, semantic-absence review and an original-source read/use; a correct guess is not enough. Physical effect violations remain authoritative even if judge prose disagrees. Maintenance results and use results never overwrite each other.

Development controls cover stale versus historical truth, invented versus faithful authority, and duplicate versus observed/unknown effects. Exported control IDs have no polarity; expected labels stay in the private key, outside SUT input. These public authored controls are dev-exposed, not held out. Failed calibration blocks semantic grading, not SUT evidence retention. Before any browser judging, bind hashes and budgets in the reviewed live freeze; maximum 12 SUT batches plus one calibration, up to three identical mechanical attempts and no semantic retry. The old #121 v3 and accepted grades are unchanged.

## What remains before live execution

The offline manifest is an implementation draft, not an approved live freeze. B0 must resolve actual provider endpoints/IDs, price and output-bound provenance, exact lane allocations/serialized request reservations, live driver route/authorization choreography, and measured reachability assumptions. The RC98304 candidate inherits RC recent-input count 2 / ratio 0.05 and overrides only Main/Task windows. Timelines include deterministic unrelated-input recipes, byte counts and 60/120-second idle waits; a finite recipe never proves exit. The current per-case forecast has **no physical request bytes**, no semantic absence proof and no completion cost guarantee. Master then chooses RC coverage or C16 deferral and approves a concrete freeze/budget. Full matrix repetition, product repairs and merge have separate gates.

中文：本阶段只完成离线准备与证据合同。新增 live 矩阵未运行，模型 ID/价格/计费上界与 RC 路线尚待冻结审批。历史 C12a 保留同一操作对账及一次写入结论，但缺少独立旧进程退出回执，按 S4 必补 C12b。Fixture 只证明工具和隔离协议，不证明模型记忆表现。所有首次失败、历史标签及缺口保留。

R3 corrections: fully covered and revision-identical paired starts; correct RC recent-input policy; route-specific, answer-free SUT timelines and deterministic filler; STALE/partial/in-flight guards and durable output-bound violations. Pair snapshots now come from the stopped checkpoint, B blocks frozen A inputs, and cleanup cannot replace the first failure. Dev controls also cover a correct guess without retrieval and separate maintenance/use judgments. Freeze generated control packet/key exactly once; randomness does not create held-out status. Before Stage B, derive cold surfaces/read-use from the same captured request and lineage rather than trusting manually supplied flags. Wall-time dispatch limits remain conservative; offline/review time before first send is excluded, and C16 scheduling/cap risk must be explicit in the live freeze.

The archive ownership checker recognizes only versioned pair receipts bound to registered runs, lineage and checkpoint. Unknown pair identities still refuse archival. This fixes the original `ARCHIVE_UNKNOWN_TOP_LEVEL` refusal for the newly introduced `pairs/` directory; the initial failed attempts remain in private receipts.

## Historical Stage C offline preparation

Run `npm run benchmark -- baseline-stage-c-prepare --root <fresh-owned-facility>` from the standalone benchmark checkout. It creates five isolated scripted fixture domains, records the C12b interrupted write and direct restart, captures C06 and control request bodies through the actual serializers with network disabled, and seals the runs. Export using `baseline-stage-c-report --root <same-facility>`. The report distinguishes fixture effects from ungraded memory semantics. The reader packet and its private key are separate. The entry accepts no provider credentials, approval or live lane.

`baseline-stage-c-plan` prints the prospective single-profile inventory. The dedicated resident-B control adds nine source lineages to the original 261. The unrelated and nonexistent-event controls reuse their independent C04 rows. Costs, live row caps, provider versions and the final freeze remain pending. Three C16 lanes remain deferred.

The prospective rows retain parent-template input, timeline and oracle hashes. Rows with measured fixtures separately identify the actual scripted inputs and a single serialized body per model. The resident-B control uses the natural-access assertion with its own corrected-day and redaction oracle. A future freeze must bind these assertions, the calibrated reader, provider identity and fresh price evidence, and per-lane request, retry, token and time limits. The 1.5-second post-verification window applies only to the scripted C12b fixture.

## Completion baseline

The default cohort fixes DeepSeek Flash across 33 observations per repeat, with a fresh source lineage for each independent scenario. C02 and C05 have one source and two probe branches each. Three repeats produce 99 observations on 93 lineages. C16 runs early on RC98304. The other rows use DEP. The archived three-model matrices and their original first failures remain available using the historical report reader.

Use `npm run benchmark -- baseline-stage-c-plan` for the inventory. To exercise one source through a native Secretary worker without a provider, use `baseline-stage-c-trial --root <fresh-facility> --case <source-case>` through the same npm entry point. Start pairs at branch A. The fixture uses shorter filler recipes. Its serializer captures, host process receipts and read-only original-event diagnostic are program evidence.

The completion freeze binds the runner and both product gitlinks, case recipes, native samples, provider source, per-role settings and blinded grading controls. A separate approval binds each batch to its SHA-256. The run and scoring commands require that approval. A closed C16 repeat needs advancing ordinary maintenance, original raw-context exit in metered requests before and after the same-domain restart, a conclusive source-bound direct lookup and a complete, final probe chain. The blind reader must audit the surfaces, classify visibility as RESIDENT or COLD, and return determinate maintenance and use grades. Every structural requirement in `c16Disposition` must also hold. A measured FAIL can close a repeat. The three repeats have separate dispositions.

The pricing projection uses peak rates for reservations. A physical send with metered components entirely outside a potential peak interval uses the published off-peak rate. A weekday peak interval with unknown holiday treatment retains a bounded estimate. Comparison across future architectures requires matched external recipes and model identity evidence as described in the Core plan.

### Recorded completion baseline, 25 November 2026

The effective comparison covers 93 source lineages and 99 observations. Seventy observations completed the workload and 59 received an accepted independent assessment. Three C16 recovery runs reached the final probe. The first maintenance judgment remains unresolved. The second and third measured a maintenance failure. All three final-use judgments passed. The frozen C16 merge gate remains open. C12a lacked a contemporaneous process-exit witness. This triggered the C12b live evidence requirement. Its two supervisor timeouts and one missing fault prerequisite leave that requirement open. [Acceptance rule](https://github.com/ExplodeCode6324/Secretary/issues/122#issuecomment-6955141574) · [C12b trigger](https://github.com/ExplodeCode6324/Secretary/issues/122#issuecomment-6957373075)

For a future architecture comparison, match the recipe hash, repeat, profile, model release, role settings and both provider routes. Use `comparison_rows_effective` for the denominator and `effective_assertions` for outcomes. The original matrix, first failures, C16 recovery series, zero-send transfers and two official quota incidents remain available separately. Five Go facilities and seven earlier archives are bound by digest. [Measured evidence](../../../evidence/issue122-completion.json) · [Core acceptance plan](https://github.com/ExplodeCode6324/Secretary/pull/136)

The row's `published_version` retains the provider spelling. Match the release using `model_release_normalized` and keep the route and identity scope in the comparison. Use only `effective_assertions` for aggregation. The historical `assertions` field includes provisional values on 11 unassessed rows.

`reason` records the runner's terminal category. For `SCENARIO_PRODUCT_BLOCKED`, consult `interruption_cause` and `workload_settlement_outcomes` before attributing a product failure. The original 402 observations record quota exhaustion. Partition 5 stopped at a metadata hold during C07-cancelled repeat 1. Partition 6's uncertain settlement belongs to C10-answer repeat 1. C10-model-created repeat 2 had one complete response and its interruption cause remains undetermined. Partition 7's 11 unsent parents record `FETCH_FAILED`. Reader slot 97 observed an HTTP response. Its physical send count is at least one and its exact count is unknown.

### Reproduce the published export

Run `python3 scripts/export-issue122.py` from the repository root to reconstruct the effective comparisons, slot dispositions and family counts from the public source rows and receipts. The CI regression also checks that changing an effective assertion fails verification.

For full byte-for-byte regeneration, supply the retained private completion receipt directory with `python3 scripts/export-issue122.py --archive-inputs <receipt-directory>`. It contains the combined report under the partition 7 residual directory, batch and facility receipts, transfer and parent bindings, meter and witness extracts, effective settings and rubric-equivalence receipts. The exporter checks the frozen output digest and compares the result with the published JSON. Add `--output <new-file>` to write the regenerated bytes.

### November 26 targeted supplement

Master approved freeze `fa647e16b20f30f7f66ffb93ec62a7044f2764ccd74297f29931cc560b7cf60a` at runner `74a8c1e50838bbbab21ab7f56bdde38d8f1fc016`, including a permanent workload stop on uncertain transmission. Both lanes were frozen on Go DeepSeek V4.1 Flash 1017. Only C16 sent requests. The first 96 requests returned complete responses. C16's 97th request settled as `NETWORK_UNCERTAIN`, with no HTTP receipt. The account recorded `GO_TARGETED_TRANSPORT_UNCERTAIN`. The trial recorded 64 inputs and two maintenance cycles but sealed zero physical observations. On November 25 UTC, request 97 was reserved at 18:43:01.911 and settled uncertain at 18:43:03.180. The sealed session changed from RUNNING (revision 347) to RECOVERY_BLOCKED (revision 348, updated 18:43:08.440 and committed at 18:43:08.455 in journal transaction 1363). This was the first blocked state in the 348 session revisions. The underlying transport cause is unknown. An authenticated quota GET after closure returned HTTP 200.

| Position | Measured outcome |
|---|---|
| C16 repeat 1, Go | INCOMPLETE, UNRESOLVED. The prospective rule fixes this result at position 1. |
| C16 repeats 2 and 3, official | Both earlier maintenance failures remain adjudicable. The combined series has 2/3 adjudicable repeats. |
| C12b repeat 1, Go | UNRUN following the hold, zero sends. The required live write, process exit, UNKNOWN and same-operation recovery witness remains open. |
| C06 resident-B repeats 2 and 3 | Archived candidates 98 and 99 remain unassessed. Old reader slot 97 retains its separate US$0.2162688-equivalent reservation. |

The sealed Hermes operator stopped during local preparation with `TARGETED_PHYSICAL_RUN`. The reader binder independently requires the workload hold to be absent. Calibration and four candidate slots had zero reservations, launches and possible sends. No formal reader series or dual grades were created. There were no new score results to add to the historical two-receipt comparisons.

The 96 confirmed responses reported Go list cost of US$0.14001463 equivalent and zero cash. The uncertain workload request carries its separate full US$0.4754877-equivalent bound. Its actual debit and cash are unknown. Summing the larger confirmed amounts per request and the uncertain reservation gives US$0.615502344 accounted against the US$5 workload limit. Reader spend was zero.

The stopped workload archive contained 4,462 files (SHA-256 `54b082d2a0604d48fb0d042e1584496be21107db1f39936c34dda1a27a3d88f7`). The independent reader archive contained 24 payloads and a manifest (SHA-256 `c0626df88464da4dada5d66e5f8a0efd7abde0986aa41c70002adca035b846d3`). Both were read back from NAS. The public result binds the workload freeze, dispatch, attempts, trial and independent pre-activation disposition. [Supplement](../../../evidence/issue122-targeted-supplement.json) · [Independent operator disposition](../../../evidence/issue122-reader-activation-blocked.json)

Run `python3 scripts/export-issue122-coverage.py --output coverage.json` to rebuild both the historical and effective assertion tables. Both tables cover 189 assertion positions across 33 branches. The 99 historical observations remain intact.

| Table | PASS | FAIL | UNRESOLVED | NOT_TESTED |
|---|---:|---:|---:|---:|
| Historical | 96 | 12 | 2 | 79 |
| Effective under the frozen position rule | 93 | 12 | 1 | 83 |

At C16 repeat 1 the historical official result had PASS for `natural_access`, `use_current` and `authority_chain`, and UNRESOLVED for `maintenance_current`. All four are NOT_TESTED in the unassessed Go position. Its fifth assertion, `item_lineage`, was already NOT_TESTED. The other replacements leave the counts unchanged.

A copied evidence bundle with the published supplement produces the same two tables. A baseline-only copy produces the historical table. The CLI summary and output file identify the included tables in `tables`. The two open live gates prevent merge readiness. To replay the pre-activation result from private verified archive members, run `node --import tsx test_case/online/benchmark/targeted-result.ts --activation-blocked ABSOLUTE_WORKLOAD_DIRECTORY evidence/issue122-reader-activation-blocked.json`.
