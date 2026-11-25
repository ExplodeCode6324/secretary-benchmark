# Validation evidence

Every result here is **ADVISORY / NOT_HUMAN_QUALIFIED**. Correctness tests establish harness behavior, not model memory performance.

- `historical-delivery.json`: allowlisted facts from locally retained #121 delivery receipts, selected-report/manifest hashes and GitHub main CI. Private model outputs, rationales, control keys and campaign internals are excluded. Per-assertion advisory rows and historical run fingerprints are now in `first-pilot-validation.json`, after verified private-source restoration. The historical report code head is separate from the future-run SUT pin.
- `deferred-work.json`: prior offline deferrals and their current resolution, including archival status. No pending item is called complete.
- `standalone-validation.json`: first standalone correctness attempt, first failures, repairs and final results. CI independently repeats the suite on Linux/macOS without live SUT requests.
- `extraction-provenance.json`: per-file baseline/current hashes and classification. Private paths and source inputs are excluded.

Historical fixed-input reports were reproducible with the private, frozen input bundle. This public repository cannot reconstruct withheld private inputs. The new standalone fixture replay is independently reproducible using the commands in the root README. No ranking, model pass rate or pooled judge-quality estimate is provided.

- `first-pilot-validation.json`: reproducible allowlist projection of the first captured pilot snapshot, later resource audit and final Opus-selected labels. These three denominators are distinct. Every published row carries the original run fingerprint. All168selected assertion labels are preserved, with private rationale/evidence text omitted. Two independent no-shell observations (three applied shell operations) remain beside the relevant labels. World positive coverage remains0/3 and external-effect observability remains partial.

Generate that projection with `python3 scripts/export-historical-evidence.py --review <verified-private-review> --replay <verified-private-replay> --extra-registries <verified-private-run-registries> --output <output-directory>`. These private source packages are not included in the public repository. Source hashes and transformation code are published; this is traceability, not public reconstruction of private data.

- `archive-verification.json`: hashes and readback scope for recovered historical packages, six additional early facilities, and prepublication standalone fixtures. Private locations are omitted. `historical-source-index.json` pins exporter input hashes; `historical-projection-verification.json` records deterministic output and tamper refusal.

- `historical-commit-reachability.json`: all seven historical commits were accessible in the public Secretary repository. This does not establish exact source reconstruction. `tracked_diff_empty` excludes untracked files; the separate source digest includes them. Commit-only reconstruction remains untested.

## Issue 122 targeted evidence

Run `python3 scripts/export-issue122-coverage.py --output coverage.json` to reconstruct 189 assertion-by-repeat cells across 33 historical branches. Each cell keeps its workload route, reader rubric, terminal reason and available archive witnesses. Seven archived offline fixtures cover eight branches. Their report digests appear in a separate field. Nine item-lineage cells reflect the pinned summarizer assigning a fresh ID to each new item.

After both targeted workloads and the independent reader series close, run the operator's offline archive readback. Use its verified final SHA in `node --import tsx test_case/online/benchmark/targeted-result.ts FACILITY SERIES FINAL_SHA` and save the resulting JSON. The exporter checks both receipt views and uses the existing C16 disposition with the observed probe chain. Supply the saved JSON and its SHA to the coverage script with `--supplement` and `--supplement-sha256` to include the four prospectively assigned positions. The historical 99 observations remain available alongside those positions.
