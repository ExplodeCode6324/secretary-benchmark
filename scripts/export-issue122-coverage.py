"""Report per-assertion coverage for the immutable historical Issue 122 baseline."""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path

BASE_SHA = "2c900be744be13ae1646242b9243c6f908e82a63204d2ec9b30bacb0062017a3"
EVIDENCE = Path(__file__).resolve().parents[1] / "evidence"
FIXTURE_SHA = "c33c2f477b79ad09c5cf991ac808680a6b5f8a67c0343597a27f44328659078e"
PUBLISHED_SUPPLEMENT_SHA = "a7221a847695481be39124554618254e8ce4cb91b74bdf5a472551157ef35b91"
LINEAGE_CASES = {"C08-inference", "C09-finished", "C16-combined"}


def checked_bytes(file, expected):
    raw = file.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError("Evidence digest mismatch")
    return json.loads(raw)


def classify(row, assertion, verdict):
    if verdict in {"PASS", "FAIL"} or (verdict == "UNRESOLVED" and row["effective_assessment"] == "ACCEPTED"):
        return None
    if assertion == "item_lineage" and row["case"] in LINEAGE_CASES:
        # The pinned Secretary summarizer assigns id() on each new item.
        return "UNREACHABLE_PRODUCT"
    if row["status"] != "COMPLETED":
        return "NOT_REACHED_LIVE"
    return "REACHED_UNASSESSED"


def summarize(baseline, fixtures):
    archives = {a["freeze_sha256"]: a["archive_sha256"] for a in baseline["archives"]}
    reports = {}
    for report in baseline["archive_verified_trial_observations"]:
        key = (report["freeze_sha256"], report["repeat"], report["seed"])
        if key in reports or report["archive_sha256"] != archives[key[0]]:
            raise ValueError("Ambiguous or unbound trial observation")
        reports[key] = report
    offline = {}
    for fixture in fixtures:
        if fixture["external_sends"] != 0 or fixture["workload"] != "OFFLINE_FIXTURE":
            raise ValueError("Invalid offline receipt")
        for case in fixture["cases"]:
            if case in offline:
                raise ValueError("Duplicate offline case")
            offline[case] = {k: fixture[k] for k in ("report_sha256", "archive_sha256")}
    groups = defaultdict(list)
    for row in baseline["comparison_rows_effective"]:
        report = reports.get((row["freeze_sha256"], row["repeat"], row["seed"]))
        witnesses = [o for o in (report or {}).get("observations", []) if o["scenario"] == row["case"]]
        if len(witnesses) > 1:
            raise ValueError("Ambiguous scenario witness")
        for assertion, verdict in row["effective_assertions"].items():
            groups[row["family"], row["case"], assertion].append({
                "repeat": row["repeat"],
                "route": row["workload_route"],
                "reader_rubric": row["reader_rubric"],
                "rubric_sha256": row["reader_rubric_sha256"],
                "workload": row["status"],
                "assessment": row["effective_assessment"],
                "result": verdict,
                "coverage_reason": classify(row, assertion, verdict),
                "terminal_reason": row["reason"],
                "ungraded_reason": row.get("effective_ungraded_reason"),
                "interruption_cause": (row.get("interruption_cause") or "UNKNOWN")
                    if row["reason"] == "OPERATION_ABORTED" else None,
                "freeze_sha256": row["freeze_sha256"],
                "archive_sha256": archives[row["freeze_sha256"]],
                "trial_sha256": report["trial_report_sha256"] if report else None,
                "journal_sha256": witnesses[0]["journal_sha256"] if witnesses else None,
            })
    matrix = []
    for (family, case, assertion), cells in sorted(groups.items()):
        cells.sort(key=lambda c: c["repeat"])
        if [c["repeat"] for c in cells] != [1, 2, 3]:
            raise ValueError("Historical repeat denominator changed")
        route_counts = defaultdict(Counter)
        for cell in cells:
            route_counts[cell["route"], cell["reader_rubric"]][cell["result"]] += 1
        matrix.append({
            "family": family, "case": case, "assertion": assertion,
            "decided": sum(c["result"] in {"PASS", "FAIL"} for c in cells),
            "strata": [{"route": route, "reader_rubric": rubric, "results": dict(counts)}
                       for (route, rubric), counts in sorted(route_counts.items())],
            "fixture_reachability": offline.get(case), "repeats": cells,
        })
    return {
        "schema": "issue122-historical-assertion-coverage-v1",
        "baseline_sha256": BASE_SHA,
        "observations": len(baseline["comparison_rows_effective"]),
        "branches": len({case for _, case, _ in groups}),
        "assertions": len(matrix),
        "repeat_assertion_cells": sum(len(row["repeats"]) for row in matrix),
        "exclusions": [{**r, "coverage_reason": "EXCLUDED"} for r in baseline["exclusions"]],
        "matrix": matrix,
    }


def effective_supplement(baseline, result):
    """Apply only the four preregistered positions, including unadjudicated attempts."""
    if result["historical_baseline_sha256"] != BASE_SHA or result["original_observations"] != 99:
        raise ValueError("Supplement uses a different historical cohort")
    expected = {("C16-combined", 1), ("C12b", 1), ("C06-resident-B", 2), ("C06-resident-B", 3)}
    rows = result["workloads"] + result["archived_reader_rows"]
    indexed = {(r["case"], r["repeat"]): r for r in rows}
    if len(rows) != 4 or set(indexed) != expected:
        raise ValueError("Unexpected supplement position")
    counts = []
    for group in baseline["matrix"]:
        cells = []
        for historical in group["repeats"]:
            row = indexed.get((group["case"], historical["repeat"]))
            if row is None:
                cells.append({"repeat": historical["repeat"], "origin": "historical", "route": historical["route"],
                              "reader_rubric_sha256": historical["rubric_sha256"], "result": historical["result"],
                              "coverage_reason": historical["coverage_reason"], "freeze_sha256": historical["freeze_sha256"]})
                continue
            grade = row["assertions"][group["assertion"]]
            if grade not in {"PASS", "FAIL", "UNRESOLVED", "NOT_TESTED"}:
                raise ValueError("Invalid supplemental assertion verdict")
            cells.append({"repeat": historical["repeat"], "origin": "supplement", "route": row["workload_route"],
                          "reader_rubric_sha256": result["reader_rubric_sha256"], "result": grade,
                          "coverage_reason": classify({"case": row["case"], "status": row.get("status", "COMPLETED"),
                                                       "effective_assessment": "ACCEPTED" if row.get("reader_accepted") else None},
                                                      group["assertion"], grade),
                          "freeze_sha256": row.get("source_freeze_sha256") or result["workload_freeze_sha256"]})
        counts.append({"family": group["family"], "case": group["case"], "assertion": group["assertion"],
                       "decided": sum(c["result"] in {"PASS", "FAIL"} for c in cells), "positions": cells})
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, default=EVIDENCE)
    parser.add_argument("--supplement", type=Path, help="Verified public targeted result")
    parser.add_argument("--supplement-sha256", help="Digest from the independently verified supplement export")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    baseline = checked_bytes(args.evidence / "issue122-completion.json", BASE_SHA)
    fixtures = checked_bytes(args.evidence / "issue122-coverage-fixtures.json", FIXTURE_SHA)
    result = summarize(baseline, fixtures)
    if (result["observations"], result["branches"], result["assertions"], result["repeat_assertion_cells"]) != (99, 33, 63, 189):
        raise ValueError("Historical matrix changed")
    if bool(args.supplement) != bool(args.supplement_sha256):
        parser.error("--supplement and --supplement-sha256 must be supplied together")
    if args.supplement is None and args.evidence.resolve() == EVIDENCE.resolve():
        args.supplement = EVIDENCE / "issue122-targeted-supplement.json"
        args.supplement_sha256 = PUBLISHED_SUPPLEMENT_SHA
    if args.supplement:
        result["supplement_sha256"] = args.supplement_sha256
        result["effective_assertion_coverage"] = effective_supplement(result, checked_bytes(args.supplement, args.supplement_sha256))
    if args.output:
        args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    else:
        print(json.dumps({k: v for k, v in result.items() if k not in {"matrix", "exclusions", "effective_assertion_coverage"}}))


if __name__ == "__main__":
    main()
