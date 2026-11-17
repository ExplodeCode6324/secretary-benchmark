# Validation evidence

Every result here is **ADVISORY / NOT_HUMAN_QUALIFIED**. Correctness tests establish harness behavior, not model memory performance.

- `historical-delivery.json`: allowlisted facts from locally retained #121 delivery receipts, selected-report/manifest hashes and GitHub main CI. Private model outputs, rationales, control keys and campaign internals are excluded. Historical performance rows are withheld pending verified provenance restoration. The historical report code head is separate from the future-run SUT pin.
- `deferred-work.json`: explicit Master-directed offline deferrals, including the complete historical first pilot and archival. No deferred item is called complete.
- `standalone-validation.json`: first standalone correctness attempt, first failures, repairs and final results. CI independently repeats the suite on Linux/macOS without live SUT requests.
- `extraction-provenance.json`: per-file baseline/current hashes and classification. Private paths and source inputs are excluded.

Historical fixed-input reports were reproducible with the private, frozen input bundle. This public repository cannot reconstruct withheld private inputs. The new standalone fixture replay is independently reproducible using the commands in the root README. No ranking, model pass rate or pooled judge-quality estimate is provided.
