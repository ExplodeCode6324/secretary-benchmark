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
