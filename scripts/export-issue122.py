"""Rebuild the frozen Issue 122 public aggregate from retained completion receipts."""

import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

FROZEN_EXPORT_SHA256 = (
    "2c900be744be13ae1646242b9243c6f908e82a63204d2ec9b30bacb0062017a3"
)
PUBLISHED = Path(__file__).resolve().parents[1] / "evidence/issue122-completion.json"


def read_json(path):
    return json.loads(path.read_bytes())


def public_reason(x):
    if x is None:
        return None
    if x == "fetch failed":
        return "FETCH_FAILED"
    if x == "The operation was aborted":
        return "OPERATION_ABORTED"
    if not re.fullmatch(r"[A-Z][A-Z0-9_]{1,100}", x):
        return "DETAILS_IN_PRIVATE_ARCHIVE"
    return x


def project_row(source, p5_metadata_hold_freeze):
    row = source["row"]
    out = {
        k: row.get(k)
        for k in (
            "family",
            "repeat",
            "profile",
            "assessment_status",
            "assessment_attempts",
            "physical_attempts_on_shared_lineage",
            "published_version",
            "identity_scope",
            "spans_observed_identity_strata",
            "pair_position",
        )
    }
    out.update(
        {
            "case": source["case_id"],
            "source_lineage": source["lane"],
            "series": source.get("series", "original"),
            "freeze_sha256": source.get("freeze_sha256"),
            "external_recipe_sha256": source.get("recipe_sha256"),
            "reader_rubric": source.get("reader_version"),
            "status": row["status"],
            "reason": public_reason(row.get("reason")),
            "assertions": row.get("grades", {}),
        }
    )
    out["workload_route"] = source.get("route", "deepseek-official")
    out["architecture"] = row.get("architecture", "Secretary")
    for k in ("seed", "sut", "pi", "runner", "reader_rubric_sha256"):
        if k in source:
            out[k] = source[k]
    identities = row.get("identities") or []
    out["returned_models"] = sorted(
        {i["returned_model"] for i in identities if i.get("returned_model")}
    )
    out["fingerprint_status_counts"] = dict(
        Counter(i.get("fingerprint_status", "UNKNOWN") for i in identities)
    )
    out["model_release_normalized"] = {
        "DeepSeek-V4.1-Flash-1017": "deepseek-v4.1-flash-1017",
        "DeepSeek V4.1 Flash 1017": "deepseek-v4.1-flash-1017",
    }[out["published_version"]]
    outcomes = Counter(i["outcome"] for i in identities)
    out["workload_settlement_outcomes"] = dict(outcomes)
    if out["reason"] == "SCENARIO_PRODUCT_BLOCKED":
        if outcomes.get("EXHAUSTED_QUOTA"):
            out["interruption_cause"] = "PROVIDER_QUOTA_EXHAUSTED"
        elif (
            out["source_lineage"] == "r1-C07-cancelled--deepseek-flash"
            and out["freeze_sha256"] == p5_metadata_hold_freeze
        ):
            out["interruption_cause"] = "GO_METADATA_HOLD"
        else:
            out["interruption_cause"] = "UNDETERMINED"
    out["first_assessment_failure"] = public_reason(row.get("first_assessment_failure"))

    if source.get("original_freeze_sha256"):
        out["original_freeze_sha256"] = source["original_freeze_sha256"]
    if row.get("c16"):
        out["c16"] = {
            k: row["c16"].get(k)
            for k in ("gate", "verdict", "branch", "retention", "use", "gaps")
        }
    if source.get("previous_assessment"):
        out["prior_assessment"] = {
            k: source["previous_assessment"].get(k)
            for k in (
                "assessment_status",
                "assessment_attempts",
                "first_assessment_failure",
            )
        }
        out["assessment_freeze_sha256"] = source["assessment_freeze_sha256"]
    return out


def derive_comparisons(out, effective_slots):
    out["go_effective_scored_slots"] = sorted(
        v["slot"] for v in effective_slots if v["assessment"] == "GRADED"
    )
    out["go_effective_ungraded_slots_by_reason"] = {
        reason: sorted(
            v["slot"]
            for v in effective_slots
            if v["assessment"] == "NOT_TESTED" and v["reason"] == reason
        )
        for reason in sorted(
            {v["reason"] for v in effective_slots if v["assessment"] == "NOT_TESTED"}
        )
    }

    # Use each effective lineage/case once for subsequent same-model comparisons.
    def identity(row):
        return row["source_lineage"], row["case"]

    chosen = {identity(row): dict(row) for row in out["original_matrix"]}
    for row in [*out["recovery_series"], *out["go_quota_recoveries"]]:
        assert identity(row) in chosen
        chosen[identity(row)] = dict(row)
    orders = {(v["lineage"], v["scenario"]): v for v in effective_slots}
    assert len(orders) == 88 and len(chosen) == 99
    paired = {
        (p["freeze_sha256"], v["slot"]): v
        for p in out["go_partitions"]
        for v in p["verified_native_and_supplemental_reader_receipts"]
        if v["stage"] == "candidate"
    }
    for key, row in chosen.items():
        stage = orders.get(key)
        if stage:
            assert row["freeze_sha256"] == stage["freeze"], (
                key,
                row["freeze_sha256"],
                stage["freeze"],
            )
            provenance = paired.get((stage["freeze"], stage["slot"]))
            accepted = stage["assessment"] == "GRADED"
            assert accepted == bool(
                provenance
                and provenance["official_status"]
                == provenance["supplemental_status"]
                == "ACCEPTED"
            )
            row["go_candidate_slot"] = stage["slot"]
            row["effective_visibility"] = (
                provenance.get("visibility") if accepted else None
            )
            row["effective_assessment"] = "ACCEPTED" if accepted else "NOT_TESTED"
            row["effective_ungraded_reason"] = (
                stage.get("reason") if not accepted else None
            )
            row["effective_assertions"] = (
                dict(row["assertions"])
                if accepted
                else {k: "NOT_TESTED" for k in row["assertions"]}
            )
        else:
            row["effective_assessment"] = row["assessment_status"]
            row["effective_assertions"] = dict(row["assertions"])
    totals = {}
    for row in chosen.values():
        k = (row["workload_route"], row["reader_rubric_sha256"], row["family"])
        cts = totals.setdefault(
            k,
            {
                "observations": 0,
                "accepted_observations": 0,
                "workload": Counter(),
                "assertions": Counter(),
            },
        )
        cts["observations"] += 1
        cts["accepted_observations"] += row["effective_assessment"] == "ACCEPTED"
        cts["workload"][row["status"]] += 1
        cts["assertions"].update(row["effective_assertions"].values())
    out["comparison_rows_effective"] = list(chosen.values())
    out["effective_family_counts_by_route_and_rubric"] = [
        {"workload_route": k[0], "rubric_sha256": k[1], "family": k[2], **stats}
        for k, stats in sorted(totals.items(), key=lambda kv: str(kv[0]))
    ]


def export(receipt_dir):
    transfers = read_json(receipt_dir / "go-r63-reader-transfers.json")
    combined = receipt_dir / transfers["7"]["out"] / "combined.json"
    c = read_json(combined)
    hold_freeze = read_json(receipt_dir / "go-r60-p5-metadata-release.json")[
        "closed_freeze"
    ]
    assert hold_freeze == read_json(receipt_dir / "go-r57-5/freeze.json")["hash"]
    assert (
        c["expected_lineages"] == 93
        and len(c["rows"]) == 99
        and len(c["c16_recovery"]) == 3
    )
    batches = []
    for b in range(2, 7):
        d = receipt_dir / ("batch-" + str(b))
        r = read_json(d / "results.json")
        f = read_json(d / "freeze.json")
        cal = read_json(d / "judge-calibration/finish.json")
        t = read_json(d / "judge-calibration/blind/a-transport.json")
        share = read_json(d / "accepted-share.json")["share"]
        batches.append(
            {
                "partition": b,
                "freeze_sha256": f["hash"],
                "archive_sha256": read_json(d / "archive.json")["archive_sha256"],
                "authorized_calls": share["physical_calls"],
                "authorized_candidate_slots": share["candidates"],
                "physical_calls": r["physical_sends"],
                "known_workload_usd": r["known_usd"],
                "unpriced_workload_reservation_usd": r[
                    "unresolved_cost_reservation_usd"
                ],
                "calibration": cal["status"],
                "calibration_metered_usd": t.get(
                    "calculated_charge_usd", t.get("charged_usd")
                ),
                "candidate_reader_metered_usd": r.get("candidate_reader_metered_usd"),
                "candidate_reader_disputed_usd": r.get("candidate_reader_disputed_usd"),
                "candidate_sends": sum(
                    1
                    for p in d.glob("judge-*/blind/a-dispatch.json")
                    if p.parent.parent.name != "judge-calibration"
                ),
                "dispositions": dict(Counter(x["status"] for x in r["rows"])),
            }
        )
    out = {
        "issue": 122,
        "matrix_sha256": c["matrix_sha256"],
        "expected_lineages": 93,
        "expected_observations": 99,
        "reported_observations": c["reported_observations"],
        "physical_attempts_all_batches": c["physical_attempts"],
        "known_workload_usd_all_batches": c["known_usd"],
        "unpriced_workload_reservation_usd_all_batches": c["unpriced_reservation_usd"],
        "reader_metered_usd_all_batches": c["reader_metered_usd"],
        "reader_disputed_usd_all_batches": c["reader_disputed_usd"],
        "c16_recovery_closed": sum(
            v["row"]["c16"]["gate"] == "CLOSED" for v in c["c16_recovery"]
        ),
        "original_dispositions": c["dispositions"],
        "supplemental_batches": batches,
        "original_matrix": [project_row(v, hold_freeze) for v in c["rows"]],
        "recovery_series": [project_row(v, hold_freeze) for v in c["c16_recovery"]],
        "per_rubric_original_family_counts": c["family_counts_by_reader"],
    }
    out["archives"] = [
        {
            "freeze_sha256": p["freeze_sha256"],
            "runner": p["runner"],
            "archive_sha256": p["archive_sha256"],
            "calibration_status": p["calibration"]["status"],
            "calibration_attempts": p["calibration"]["attempts"],
        }
        for p in c["proposals"]
    ]
    out["original_official_C04_calibrations"] = [
        {
            k: v.get(k)
            for k in (
                "status",
                "matched",
                "labels_received",
                "total_controls",
                "metered_usd",
                "finish_reason",
                "receipt_sha256",
            )
        }
        for v in c["proposals"][0]["calibration"]["history"]
    ]
    out["exclusions"] = c["excluded"]
    out["official_known_workload_usd"] = out.pop("known_workload_usd_all_batches")
    out["official_unpriced_workload_reservation_usd"] = out.pop(
        "unpriced_workload_reservation_usd_all_batches"
    )
    out["official_reader_metered_usd"] = out.pop("reader_metered_usd_all_batches")
    out["original_402_rows"] = [
        project_row(v, hold_freeze)
        for v in c["rows"]
        if v["row"].get("identities")
        and v["row"]["identities"][0].get("outcome") == "EXHAUSTED_QUOTA"
    ]
    out["go_quota_recoveries"] = [
        project_row(v, hold_freeze) for v in c.get("go_quota_recovery", [])
    ]
    out["go_zero_send_originals"] = [
        project_row(v, hold_freeze) for v in c.get("go_zero_send_originals", [])
    ]
    out["go_residual_zero_send_originals"] = [
        project_row(v, hold_freeze)
        for v in c.get("go_residual_zero_send_originals", [])
    ]
    out["family_counts_by_route"] = c.get("family_counts_by_route", [])
    out["go_partitions"] = []
    transfers = {
        int(k): v
        for k, v in read_json(receipt_dir / "go-r63-reader-transfers.json").items()
    }
    for b, residual in [(5, False), (5, True), (6, False), (7, False), (7, True)]:
        d = receipt_dir / (transfers[b]["out"] if residual else "go-r57-" + str(b))
        p = d / "results.json"
        assert p.exists() and (d / "archive.json").exists(), "Missing final Go archive"
        r = read_json(p)
        a = read_json(d / "archive.json")
        info = {
            "partition": b,
            "residual": residual,
            "freeze_sha256": read_json(d / "freeze.json")["hash"],
            "archive_sha256": a["archive_sha256"],
            "recovery_route": "opencode-go",
            "lineages": r["lineages"],
            "observations": r["observations"],
            "physical_sends": r["physical_sends"],
            "billing_basis": r["billing_basis"],
            "tariff_estimate_usd": r["tariff_estimate_usd"],
            "unresolved_tariff_reservation_usd": r["unresolved_tariff_reservation_usd"],
            "provider_cash_known_usd": r.get("provider_cash_known_usd"),
            "provider_cash_unknown_requests": r.get("provider_cash_unknown_requests"),
            "scored_candidates": sum(
                x["assessment_status"] == "ACCEPTED" for x in r["rows"]
            ),
            "native_reader_totals": {
                k: r["candidate_reader_go"].get(k)
                for k in (
                    "inference_dispatches",
                    "unsettled_reservations",
                    "metered_responses",
                    "prompt_tokens",
                    "completion_tokens",
                )
            },
        }
        paired = d / "archived-reader-audit.json"
        if paired.exists():
            info["verified_native_and_supplemental_reader_receipts"] = read_json(
                paired
            )["receipts"]
        if (d / "candidate-slots.json").exists():
            info["candidate_slots"] = read_json(d / "candidate-slots.json")["slots"]
        if (d / "calibration-dispositions.json").exists():
            info["calibration_verdicts"] = read_json(
                d / "calibration-dispositions.json"
            )
        if (d / "effective-withheld.json").exists():
            info["effective_withheld"] = read_json(d / "effective-withheld.json")
        for slot in info["candidate_slots"]:
            if (
                slot.get("physical_reader_sends") is None
                and slot.get("provider_delivery") == "HTTP_RESPONSE_OBSERVED"
            ):
                slot["physical_reader_sends_lower_bound"] = 1
        out["go_partitions"].append(info)
    effective_slots = [
        v
        for part in out["go_partitions"]
        for v in part.get("candidate_slots", [])
        if v.get("reason") != "ZERO_SEND_TRANSFERRED_TO_RESIDUAL"
    ]
    assert len(out["go_partitions"]) == 5
    assert (
        len({r["freeze_sha256"] for r in out["go_partitions"]})
        == len({r["archive_sha256"] for r in out["go_partitions"]})
        == 5
    )
    assert all(
        any(
            v["freeze_sha256"] == r["freeze_sha256"]
            and v["archive_sha256"] == r["archive_sha256"]
            for v in out["archives"]
        )
        for r in out["go_partitions"]
    )
    for b, cfg in transfers.items():
        pair = {p["residual"]: p for p in out["go_partitions"] if p["partition"] == b}
        parent, child = pair[False], pair[True]
        assert parent["freeze_sha256"] == cfg["parent_freeze"]
        superseded = [
            row
            for row in parent["candidate_slots"]
            if row.get("reason") == "ZERO_SEND_TRANSFERRED_TO_RESIDUAL"
        ]
        assert len(superseded) == len(child["candidate_slots"]) == len(cfg["lanes"])
        for i, (old, new) in enumerate(zip(superseded, child["candidate_slots"])):
            assert (
                old["slot"] == new["slot"] == cfg["first_slot"] + i
                and old["lineage"] == new["lineage"] == cfg["lanes"][i]
                and old["physical_reader_sends"] == 0
            )
            assert (
                old["parent_freeze"] == new["parent_freeze"] == parent["freeze_sha256"]
                and old["effective_freeze"] == new["freeze"] == child["freeze_sha256"]
            )

    meters = read_json(receipt_dir / "go-archive-meters.json")
    assert {v["archive_sha256"] for v in meters} == {
        v["archive_sha256"] for v in out["go_partitions"]
    }
    p7parent, p7child = [p for p in out["go_partitions"] if p["partition"] == 7]
    p5 = next(
        p for p in out["go_partitions"] if p["partition"] == 5 and not p["residual"]
    )
    ancestry = read_json(
        receipt_dir / transfers[7]["out"] / "parent-postgrade-archive.json"
    )
    assert (
        ancestry["child_archive_sha256"] == p7child["archive_sha256"]
        and ancestry["child_freeze_sha256"] == p7child["freeze_sha256"]
        and ancestry["parent_archive_sha256"] == p7parent["archive_sha256"]
        and ancestry["p5_calibration"]["archive_sha256"] == p5["archive_sha256"]
        and ancestry["transfer_slots"] == list(range(89, 100))
    )
    out["go_p7_residual_postgrade_parent"] = ancestry
    out["go_reported_usage_from_archived_settlements"] = meters
    out["go_effective_workload_settings"] = read_json(
        receipt_dir / "go-r63-before-grade-audit.json"
    )["sessions"]
    official_physical = sum(b["physical_calls"] for b in out["supplemental_batches"])
    go_physical = sum(b["physical_sends"] for b in out["go_partitions"])
    assert (
        c["physical_attempts"] >= official_physical + go_physical
        and official_physical + go_physical <= 10620
    )
    cal_native = receipt_dir / "go-r57-5/judge-calibration/native-recovery.json"
    cal_delivery = read_json(cal_native) if cal_native.is_file() else {}
    dispatched_cal = (
        None
        if cal_delivery.get("provider_delivery") == "UNKNOWN"
        else 0
        if cal_delivery.get("state") == "NOT_SENT"
        else 1
        if cal_delivery.get("provider_delivery") == "HTTP_RESPONSE_OBSERVED"
        else None
    )
    go_known = sum(
        v["physical_reader_sends"]
        for v in effective_slots
        if v.get("physical_reader_sends") is not None
    )
    go_unknown = sum(v.get("physical_reader_sends") is None for v in effective_slots)
    official_candidates = sum(b["candidate_sends"] for b in out["supplemental_batches"])
    assert official_candidates + go_known + go_unknown <= 99
    out["six_batch_authorization_usage"] = {
        "workload_sends": official_physical + go_physical,
        "prior_authorization_workload_sends": c["physical_attempts"]
        - official_physical
        - go_physical,
        "workload_send_max": 10620,
        "workload_hard_usd_max": 8197.144704,
        "official_reader_calibrations": len(out["supplemental_batches"]),
        "go_calibration_known_physical": dispatched_cal,
        "total_calibration_max": 6,
        "official_candidate_sends": official_candidates,
        "go_candidate_known_sends": go_known,
        "go_candidate_unknown_sends": go_unknown,
        "total_candidate_max": 99,
        "reader_hard_usd_max": 21.823488,
    }
    out["visibility_decision"] = {
        "target": "current fact at first eligible request",
        "RESIDENT": "Sufficient visible evidence establishes the target.",
        "COLD": "No surface establishes the target and every surface is captured and inspectable.",
        "OPAQUE": "No sufficient visible evidence and at least one surface is missing, uninspected, truncated, or unresolved.",
    }
    assert sorted(v["slot"] for v in effective_slots) == list(range(12, 100))
    derive_comparisons(out, effective_slots)
    out["included_routes"] = sorted(
        {r["workload_route"] for r in out["original_matrix"]}
    )
    out["official_effective_settings_from_transmitted_requests"] = read_json(
        receipt_dir / "official-effective-settings.json"
    )
    out["go_reader_equivalence"] = read_json(receipt_dir / "go-rubric-equivalence.json")
    witnesses = receipt_dir / "go-physical-witnesses.json"
    records = read_json(witnesses)
    verified = {r["archive_sha256"] for r in out["archives"]}
    assert {r["archive_sha256"] for r in records} <= verified
    if out["go_partitions"]:
        assert all(
            p["archive_sha256"] in {r["archive_sha256"] for r in records}
            for p in out["go_partitions"]
            if p["physical_sends"]
        )
    out["archive_verified_trial_observations"] = records

    contact = read_json(receipt_dir / "go-r57-5/contact-meter-audit.json")
    obs = contact["physical"]
    out["go_first_contact"] = {
        "freeze_sha256": contact["freeze"],
        "lineage": contact["first_lane"],
        "terminal": contact["terminal"],
        "physical_sends": len(obs),
        "returned_models": sorted({x["returned_model"] for x in obs}),
        "reported_cash_usd": round(sum(x["cash_debit_usd"] for x in obs), 9),
        "provider_allowance_usd": round(sum(x["allowance"] for x in obs), 9),
        "provider_list_usd": round(sum(x["list_usd"] for x in obs), 9),
        "fingerprint_status_counts": dict(
            Counter(x["fingerprint_status"] for x in obs)
        ),
        "replay": contact["replay"],
    }

    assert out["c16_recovery_closed"] == c["c16_closed"]
    return out


def verify_derived(report):
    slots = [
        slot
        for part in report["go_partitions"]
        for slot in part["candidate_slots"]
        if slot.get("reason") != "ZERO_SEND_TRANSFERRED_TO_RESIDUAL"
    ]
    keys = (
        "go_effective_scored_slots",
        "go_effective_ungraded_slots_by_reason",
        "comparison_rows_effective",
        "effective_family_counts_by_route_and_rubric",
    )
    expected = {k: report[k] for k in keys}
    base = {k: v for k, v in report.items() if k not in expected}
    derive_comparisons(base, slots)
    for k, value in expected.items():
        if base[k] != value:
            raise ValueError(f"Mismatch in derived field {k}")
    assert report["c16_recovery_closed"] == sum(
        row["c16"]["gate"] == "CLOSED" for row in report["recovery_series"]
    )
    assert len(slots) == len({s["slot"] for s in slots}) == 88
    assert all(
        v == "NOT_TESTED"
        for row in base["comparison_rows_effective"]
        if row["effective_assessment"] == "NOT_TESTED"
        for v in row["effective_assertions"].values()
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--archive-inputs",
        type=Path,
        help="Private retained completion receipt directory",
    )
    parser.add_argument("--published", type=Path, default=PUBLISHED)
    parser.add_argument(
        "--output", type=Path, help="Write the verified frozen export to this path"
    )
    args = parser.parse_args()
    if not __debug__:
        parser.error("Run with Python assertions enabled")
    if args.archive_inputs:
        data = export(args.archive_inputs)
        raw = (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode()
        if hashlib.sha256(raw).hexdigest() != FROZEN_EXPORT_SHA256:
            raise ValueError("Unexpected frozen export digest")
        verify_derived(data)
        if args.output:
            args.output.write_bytes(raw)
        else:
            if raw != args.published.read_bytes():
                raise ValueError("Archive regeneration differs from the published file")
        print("Archive regeneration matched", FROZEN_EXPORT_SHA256)
        return
    if args.output:
        parser.error("--output requires --archive-inputs")
    published = args.published.read_bytes()
    verify_derived(json.loads(published))


if __name__ == "__main__":
    main()
