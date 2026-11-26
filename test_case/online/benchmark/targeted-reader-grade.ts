import { isDeepStrictEqual } from "node:util";
import { sha, requireThat } from "./io.ts";
import { gradeJSONBytes } from "./grading-transaction.ts";
import { matchesReader, scoringRubric } from "./stage-c-grading.ts";
import { goReaderResponse, supplementSlots } from "./stage-c-go-grading.ts";
import {
  admittedReaderQuery,
  goReader,
  goVisibilityVersion,
  goReaderPolicy,
} from "./stage-c-visibility-rubric.ts";

export const targetedSeries = "issue122-r67-evidence-v1";
export const retestSeries = "issue122-r75-retest-v1";
export const continuationSeries = "issue122-r77-continuation-v1";
export type TargetedRoute = keyof typeof supplementSlots;
export const targetedRoutes = Object.keys(supplementSlots) as TargetedRoute[];
const hex = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export const routeScenario = {
  "c16-repeat1": "C16-combined",
  c12b: "C12b",
  "c06-98": "C06-resident-B",
  "c06-99": "C06-resident-B",
};
const historical = {
  "c06-98": {
    lineage: "r2-C06-resident-B--deepseek-flash",
    packet: "123ca63d1454f6dc89f02efedce53f6c1f74157d86bc863655f4af9d29ffb526",
    query: "e9253836f1f90be7c309dd82087b72cc445b7d6789d21cf5abb008b15f24b535",
    zero: "51307bc0cd9bde85e45cba081e8e03a65f33a0db5110587d8422b8fe36ae8ef6",
  },
  "c06-99": {
    lineage: "r3-C06-resident-B--deepseek-flash",
    packet: "f7741a808171780658b466e2731b6209cc98018f47c66d9b8fa4b3815f23f8ef",
    query: "38eea15b2e0e7539c4688bead0b73401eb3ef156fc8cf749bde39df0f9241f19",
    zero: "9c60bdfbaca3688ede9eb74743d703ed8aeb6158f33c013feb4f35d7add270f5",
  },
};
const same = (a: any, b: any, code: string) =>
  requireThat(isDeepStrictEqual(a, b), code);
export type RouteFreeze = {
  decision_sha256: string;
  packet_sha256: string;
  query_sha256: string;
  binding_sha256: string;
};
export interface TargetedReaderFreeze {
  series:
    typeof targetedSeries | typeof retestSeries | typeof continuationSeries;
  rubric_sha256: string;
  key_sha256: string;
  workload_freeze_sha256: string;
  workload_dispatch_sha256: string;
  unavailable?: Partial<Record<"c16-repeat1" | "c12b", string>>;
  routes: Record<TargetedRoute, RouteFreeze>;
  archived: Record<
    "c06-98" | "c06-99",
    {
      slot: number;
      lineage: string;
      parent_freeze_sha256: string;
      source_freeze_sha256: string;
      source_archive_sha256: string;
      no_send_sha256: string;
      sends: 0;
    }
  >;
}
export function validateTargetedFreeze(f: TargetedReaderFreeze) {
  requireThat(
    (f.series === targetedSeries ||
      f.series === retestSeries ||
      f.series === continuationSeries) &&
      hex(f.key_sha256) &&
      f.rubric_sha256 ===
        sha(gradeJSONBytes(scoringRubric(goReader, goVisibilityVersion))),
    "TARGETED_POLICY",
  );
  requireThat(
    hex(f.workload_freeze_sha256) && hex(f.workload_dispatch_sha256),
    "TARGETED_WORKLOAD_DIGEST",
  );
  const unavailable = Object.keys(f.unavailable ?? {});
  requireThat(
    unavailable.every(
      (r) =>
        (r === "c16-repeat1" || r === "c12b") &&
        typeof f.unavailable![r] === "string" &&
        f.unavailable![r]!.trim().length > 0,
    ),
    "TARGETED_UNAVAILABLE",
  );
  const eligible =
    f.series !== targetedSeries
      ? targetedRoutes.filter((r) => !r.startsWith("c06-"))
      : targetedRoutes;
  const active = eligible.filter((r) => !unavailable.includes(r));
  same(Object.keys(f.routes).sort(), [...active].sort(), "TARGETED_ROUTES");
  for (const route of active) {
    const row = f.routes[route];
    requireThat(
      [
        row.decision_sha256,
        row.packet_sha256,
        row.query_sha256,
        row.binding_sha256,
      ].every(hex),
      "TARGETED_INPUT_DIGEST",
    );
  }
  for (const k of ["packet_sha256", "query_sha256"] as const)
    requireThat(
      new Set(active.map((r) => f.routes[r][k])).size === active.length,
      "TARGETED_DUPLICATE_INPUT",
    );
  if (f.series !== targetedSeries) {
    same(f.archived, {}, "TARGETED_ARCHIVE_ROUTES");
    return;
  }
  same(
    Object.keys(f.archived).sort(),
    ["c06-98", "c06-99"],
    "TARGETED_ARCHIVE_ROUTES",
  );
  for (const route of ["c06-98", "c06-99"] as const) {
    const source = f.archived[route],
      pin = historical[route],
      row = f.routes[route];
    requireThat(
      source.slot === Number(route.slice(4)) &&
        source.lineage === pin.lineage &&
        source.sends === 0 &&
        source.parent_freeze_sha256 ===
          "97bcbda3897e51b4fa06c86b398650f9ff5437ce07ce046fcf51c97e96e8d583" &&
        source.source_freeze_sha256 ===
          "0864d8b8df9222f8f275ebd66dd98dac9f02c678d508d83944b4fcef2b928145" &&
        source.source_archive_sha256 ===
          "bbda900a503439b356dc215a896e87e8ad61be04419a4fd0075195da92e0454e" &&
        source.no_send_sha256 === pin.zero &&
        row.packet_sha256 === pin.packet &&
        row.query_sha256 === pin.query,
      "TARGETED_ARCHIVED_SOURCE",
    );
  }
}

export interface OriginalFiles {
  raw: string;
  query: string;
  metadata: string;
  dispatch: any;
  transport: any;
  receipt: string | null;
}
export type CalibrationIdentity = {
  native_at: string;
  returned_model: string;
  packet_sha256: string;
  transport_sha256: string;
  official_sha256: string;
  supplemental_sha256: string;
};
export function validateTargetedInput(
  f: TargetedReaderFreeze,
  route: TargetedRoute,
  packet: any,
  binding: any,
) {
  validateTargetedFreeze(f);
  requireThat(Object.hasOwn(supplementSlots, route), "TARGETED_ROUTE");
  requireThat(Object.hasOwn(f.routes, route), "TARGETED_UNAVAILABLE");
  const pin = f.routes[route],
    query = admittedReaderQuery(packet);
  requireThat(
    sha(gradeJSONBytes(packet)) === pin.packet_sha256 &&
      sha(query) === pin.query_sha256 &&
      sha(gradeJSONBytes(binding)) === pin.binding_sha256 &&
      sha(gradeJSONBytes(packet.rubric)) === f.rubric_sha256,
    "TARGETED_FROZEN_BYTES",
  );
  if (route === "calibration") {
    requireThat(
      Array.isArray(packet.controls) &&
        packet.controls.length === 28 &&
        packet.controls.filter((x: any) => x.assertion === "visibility")
          .length === 6 &&
        new Set(packet.controls.map((x: any) => x.id)).size === 28,
      "TARGETED_CALIBRATION_CONTROLS",
    );
  } else {
    requireThat(
      binding.scenario === routeScenario[route] &&
        !Array.isArray(packet.controls) &&
        Array.isArray(packet.evidence) &&
        new Set(packet.evidence.map((e: any) => e.id)).size ===
          packet.evidence.length,
      "TARGETED_CANDIDATE",
    );
    if (route === "c16-repeat1")
      requireThat(
        hex(binding.capture_sha256) &&
          Array.isArray(binding.capture_gaps) &&
          Array.isArray(binding.maintenance_evidence_ids) &&
          binding.maintenance_evidence_ids.length >= 4 &&
          binding.maintenance_evidence_ids.every((id: string) =>
            packet.evidence.some((e: any) => e.id === id),
          ),
        "TARGETED_CAPTURE_BINDING",
      );
  }
  return query;
}
function verdict(
  mark: any,
  packet: any,
  binding: any,
  key: any,
  route: TargetedRoute,
  digest: string,
) {
  if (mark?.mechanical)
    return { status: "MECHANICAL", reason: mark.mechanical };
  if (mark?.rejected) return { status: "REJECTED", reason: mark.rejected };
  if (
    !mark ||
    typeof mark !== "object" ||
    Array.isArray(mark) ||
    !matchesReader(mark, digest, goReader)
  )
    return { status: "REJECTED", reason: "RESPONSE_BINDING" };
  if (route === "calibration") {
    const labels = mark.labels;
    const matched = Array.isArray(labels)
      ? key.filter(
          (k: any) =>
            labels.filter(
              (r: any) => r?.id === k.id && r?.verdict === k.expected,
            ).length === 1,
        ).length
      : 0;
    return {
      status: matched === 28 && labels.length === 28 ? "PASSED" : "FAILED",
      matched,
    };
  }
  const rows = mark.assertions;
  const valid =
    Array.isArray(rows) &&
    rows.length === packet.assertions.length &&
    packet.assertions.every(
      (a: string) =>
        rows.filter(
          (r: any) =>
            r?.assertion === a &&
            ["PASS", "FAIL", "UNRESOLVED", "NOT_TESTED"].includes(r.verdict) &&
            typeof r.rationale === "string" &&
            r.rationale.trim() &&
            Array.isArray(r.evidence) &&
            (r.verdict === "NOT_TESTED" || r.evidence.length > 0) &&
            r.evidence.every((id: string) =>
              packet.evidence.some((e: any) => e.id === id),
            ),
        ).length === 1,
    );
  if (!valid) return { status: "REJECTED", reason: "ASSERTION_EVIDENCE" };
  let visibility = mark.visibility;
  if (route === "c16-repeat1") {
    const refs = mark.visibility_evidence;
    if (
      !["RESIDENT", "COLD", "OPAQUE"].includes(visibility) ||
      !Array.isArray(refs) ||
      !refs.length ||
      !refs.every((id: string) =>
        packet.evidence.some((e: any) => e.id === id),
      ) ||
      !(visibility === "RESIDENT"
        ? refs.every((id: string) => binding.wire_ids.includes(id))
        : refs.includes(binding.coverage_id))
    )
      return { status: "REJECTED", reason: "VISIBILITY_EVIDENCE" };
    if (visibility === "COLD" && !binding.surfaceComplete)
      visibility = "OPAQUE";
  }
  return { status: "ACCEPTED", visibility, assertions: rows };
}
export function verifyTargetedReceipt(
  f: TargetedReaderFreeze,
  seriesDigest: string,
  route: TargetedRoute,
  packet: any,
  binding: any,
  origin: CalibrationIdentity | null,
  key: any,
  files: OriginalFiles,
) {
  const query = validateTargetedInput(f, route, packet, binding),
    pin = f.routes[route],
    t = files.transport,
    d = files.dispatch;
  requireThat(
    hex(seriesDigest) &&
      sha(gradeJSONBytes(f)) === seriesDigest &&
      files.query === query &&
      files.metadata === t.binding_metadata_utf8 &&
      sha(files.metadata) === d.metadata_sha256,
    "TARGETED_SOURCE_BYTES",
  );
  if (route === "calibration") {
    requireThat(
      !origin &&
        sha(gradeJSONBytes(key)) === f.key_sha256 &&
        Array.isArray(key) &&
        key.length === 28 &&
        new Set(key.map((k) => k.id)).size === 28 &&
        key.every((k) => packet.controls.some((c: any) => c.id === k.id)),
      "TARGETED_PRIVATE_KEY",
    );
  } else {
    requireThat(
      origin &&
        origin.packet_sha256 === f.routes.calibration.packet_sha256 &&
        [
          origin.transport_sha256,
          origin.official_sha256,
          origin.supplemental_sha256,
        ].every(hex) &&
        origin.native_at === t.calibration_native_at &&
        origin.returned_model === t.calibration_returned_model,
      "TARGETED_SHARED_CALIBRATION",
    );
  }
  const runtime =
    "731e2f79d05eb74344c6ccd217c0b2835ccd876e17f9a4b2d6e1aafdc03f0d2e";
  requireThat(
    t.runtime_reference_sha256 === runtime &&
      d.runtime_reference_sha256 === runtime,
    "TARGETED_NATIVE_RUNTIME",
  );
  const native = { raw: files.raw, transport: t, dispatch: d };
  const mark = goReaderResponse(native, packet, pin.decision_sha256, {
    series: f.series,
    series_sha256: seriesDigest,
    route,
  });
  const envelopeDigest = sha(gradeJSONBytes(native));
  if (mark?.mechanical || mark?.rejected)
    requireThat(
      mark.evidence_sha256 === envelopeDigest,
      "TARGETED_FAILURE_EVIDENCE",
    );
  const official = verdict(
    mark,
    packet,
    binding,
    key,
    route,
    pin.packet_sha256,
  );
  const rawHash = sha(files.raw);
  requireThat(
    rawHash === t.raw_sha256 &&
      (t.receipt_sha256 ?? null) ===
        (files.receipt === null ? null : sha(files.receipt)),
    "TARGETED_NATIVE_RECEIPT_BYTES",
  );
  if (files.receipt !== null) {
    const text = files.raw.trim(),
      unfenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i.exec(
        text,
      );
    requireThat(
      files.receipt === (unfenced ? unfenced[1] : files.raw),
      "TARGETED_EXTRACTED_RESPONSE",
    );
  }
  const unauthorized =
    (t.go_billing_source != null || t.http_status === 200) &&
    !["go", "go-plus", "go-teams", "free"].includes(t.go_billing_source);
  const cash = t.go_reported_cash_usd;
  requireThat(
    cash == null ||
      (typeof cash === "number" && Number.isFinite(cash) && cash >= 0),
    "TARGETED_PROVIDER_CASH",
  );
  const badPayer =
    f.series !== continuationSeries && (unauthorized || (cash ?? 0) > 0);
  if (badPayer)
    requireThat(t.quota_stop === true, "TARGETED_BILLING_HOLD_MISSING");
  const supplemental = badPayer
    ? { status: "REJECTED", reason: "UNEXPECTED_BILLING_SOURCE" }
    : t.quota_stop
      ? { status: "NOT_TESTED", reason: "NATIVE_ACCOUNT_HOLD" }
      : files.receipt === null
        ? { status: "NOT_TESTED", reason: "NO_NATIVE_RECEIPT" }
        : verdict(
            JSON.parse(files.receipt),
            packet,
            binding,
            key,
            route,
            pin.packet_sha256,
          );
  // A valid semantic JSON cannot replace an official mechanical or transport disposition.
  const accepted =
    (official.status === "PASSED" || official.status === "ACCEPTED") &&
    official.status === supplemental.status;
  const blockedMaintenance =
    route === "c16-repeat1" &&
    accepted &&
    (binding.capture_gaps.length > 0 ||
      official.visibility === "OPAQUE" ||
      official.assertions?.some(
        (r: any) =>
          ["maintenance_current", "use_current"].includes(r.assertion) &&
          !["PASS", "FAIL"].includes(r.verdict),
      ));
  const result = {
    series: f.series,
    series_sha256: seriesDigest,
    route,
    decision_sha256: pin.decision_sha256,
    packet_sha256: pin.packet_sha256,
    query_sha256: pin.query_sha256,
    binding_sha256: pin.binding_sha256,
    response_sha256: sha(gradeJSONBytes(mark)),
    evidence_sha256: envelopeDigest,
    runtime_reference_sha256: runtime,
    raw_sha256: rawHash,
    receipt_sha256: t.receipt_sha256 ?? null,
    official,
    supplemental,
    accepted,
    mechanical_effects:
      route === "c12b" ? binding.workload?.mechanical_effects : null,
    maintenance_evidence_inconclusive: !!blockedMaintenance,
    returned_model: t.returned_model,
    calibration_origin: origin,
    calibration_native_at: t.go_catalog.at,
    billing_basis: goReaderPolicy.billing_basis,
    cash_charge_usd: null,
    reported_cash_usd: cash ?? null,
    provider_allowance: t.go_allowance ?? null,
    provider_list_cost_usd: t.go_list_cost_usd ?? null,
    usage: t.usage ?? null,
    verifier_provider_calls: 0,
  };
  return result;
}
