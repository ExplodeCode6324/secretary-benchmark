import { residualParent } from "./stage-c-go-residual.ts";
import { isDeepStrictEqual } from "node:util";
import { Domains } from "./domain.ts";
import {
  gradeJSONBytes,
  commitGradeFiles,
  assertGradeStore,
  readOwnedGradeJSON,
  readOwnedGradeFile,
} from "./grading-transaction.ts";
import { sha, requireThat } from "./io.ts";
import {
  goReader,
  goReaderPolicy as policy,
  goVisibilityVersion,
  admittedReaderQuery,
} from "./stage-c-visibility-rubric.ts";

const hex = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const number = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
const dir = "oracles/completion/calibration";

export type GoCalibrationOrigin = {
  freeze_sha256: string;
  archive_sha256: string;
  receipt_sha256: string;
  packet_sha256: string;
  key_sha256: string;
  rubric_sha256: string;
  transport_sha256: string;
};

function snapshot(value: any, url: string) {
  return (
    value?.url === url &&
    value.status === 200 &&
    Number.isFinite(Date.parse(value.at))
  );
}
function windows(value: any, before: boolean) {
  return (
    snapshot(value, policy.usage_endpoint) &&
    ["rolling", "weekly", "monthly"].every((k) => {
      const w = value.data?.[k];
      return (
        w &&
        typeof w.status === "string" &&
        number(w.percent) &&
        (!before || (w.status === "ok" && w.percent < 100))
      );
    })
  );
}

export function goHeadroom(
  value: any,
  calibrated: boolean,
  local: Record<string, number>,
) {
  const capacities = policy.capacity_usd_equivalent,
    names = Object.keys(capacities);
  requireThat(
    local &&
      !Array.isArray(local) &&
      Object.keys(local).length === names.length &&
      names.every((name) => number(local[name])),
    "STAGE_C_GO_LOCAL_RESERVATIONS",
  );
  const cap =
    policy.request_ceiling_usd_equivalent[
      calibrated ? "calibration" : "candidate"
    ];
  const scale = 1_000_000_000,
    gross: Record<string, number> = {},
    net: Record<string, number> = {},
    projected: Record<string, number> = {};
  for (const [name, capacity] of Object.entries(capacities)) {
    const observed =
      capacity *
      Math.max(0, 99 - Math.ceil(value?.data?.[name]?.percent)) *
      (scale / 100);
    const localUnits = Math.ceil(Math.min(capacity, local[name]) * scale);
    const netUnits = Math.max(0, observed - localUnits);
    gross[name] = observed / scale;
    net[name] = netUnits / scale;
    projected[name] = (netUnits - Math.round(cap * scale)) / scale;
  }
  return {
    request_ceiling_usd_equivalent: cap,
    capacity_usd_equivalent: capacities,
    observed_headroom_usd_equivalent: gross,
    go_local_unreflected_usd: local,
    remaining_usd_equivalent: net,
    after_request_usd_equivalent: projected,
    rounding_margin_percentage_points: 1,
    admitted:
      windows(value, true) && Object.values(projected).every((v) => v >= 0),
  };
}

export function sourceCalibrationBinding(t: any) {
  requireThat(
    [policy.model, policy.canonical_id].includes(t?.returned_model) &&
      snapshot(t?.go_catalog, policy.models_endpoint),
    "STAGE_C_GO_CALIBRATION_IDENTITY",
  );
  return {
    calibration_returned_model: t.returned_model,
    calibration_native_at: t.go_catalog.at,
  };
}

export function calibrationAgeOK(source: string, at: string) {
  const age = Date.parse(at) - Date.parse(source);
  return age >= 0 && age <= 86400000;
}
export const supplementSlots = {
  calibration: 1,
  "c16-repeat1": 1,
  c12b: 2,
  "c06-98": 3,
  "c06-99": 4,
} as const;
export type SupplementNativeBinding = {
  series: "issue122-r67-evidence-v1" | "issue122-r75-retest-v1" | "issue122-r77-continuation-v1";
  series_sha256: string;
  route: keyof typeof supplementSlots;
};
export function goReaderResponse(
  envelope: any,
  packet: any,
  freeze: string,
  supplement?: SupplementNativeBinding,
) {
  const { raw, dispatch: d, transport: t } = envelope ?? {};
  const query = admittedReaderQuery(packet),
    input = sha(query),
    packetSha = sha(gradeJSONBytes(packet));
  const calibrated = Array.isArray(packet.controls);
  const continuation = supplement?.series === "issue122-r77-continuation-v1";
  if (supplement)
    requireThat(
      (supplement.series === "issue122-r67-evidence-v1" ||
        ((supplement.series === "issue122-r75-retest-v1" || continuation) &&
          ["calibration", "c16-repeat1", "c12b"].includes(supplement.route))) &&
        hex(supplement.series_sha256) &&
        Object.hasOwn(supplementSlots, supplement.route) &&
        (supplement.route === "calibration") === calibrated,
      "STAGE_C_TARGETED_ROUTE",
    );
  const wire =
    Buffer.byteLength(JSON.stringify(query)) + policy.wire_envelope_bytes;
  const serialized = JSON.stringify({
    messages: [{ role: "user", content: query }],
    model: policy.model,
    max_tokens: policy.max_output_tokens,
    reasoning_effort: policy.reasoning_effort,
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: policy.thinking_type },
  });
  const identity = {
    ...supplement,
    stage: calibrated ? "calibration" : "candidate",
    request_model: policy.model,
    model: policy.model,
    provider: policy.provider,
    endpoint: policy.endpoint,
    reasoning_effort: policy.reasoning_effort,
    thinking_type: policy.thinking_type,
    max_tokens: policy.max_output_tokens,
    wire_bytes: wire,
    input_sha256: input,
    packet_sha256: packetSha,
    decision_sha256: freeze,
    native_entry: "AIAgent.run_conversation",
    native_session_header_verified: true,
    session_created_by_hermes: true,
    tools: 0,
    fallback: false,
    automatic_retries: 0,
    inference_dispatches: 1,
    billing_basis: policy.billing_basis,
  };
  const bindingMetadata = {
    ...supplement,
    stage: identity.stage,
    batch: t?.batch,
    slot: t?.slot,
    query_sha256: input,
    packet_sha256: packetSha,
    decision_sha256: freeze,
    go_local_unreflected_usd: t?.go_local_unreflected_usd,
    ...(calibrated
      ? {}
      : {
          calibration_returned_model: t?.calibration_returned_model,
          calibration_native_at: t?.calibration_native_at,
        }),
  };
  requireThat(
    hex(freeze) &&
      typeof raw === "string" &&
      t &&
      d &&
      Object.entries(identity).every(
        ([key, v]) => d[key] === v && t[key] === v,
      ) &&
      packet.rubric?.reader === goReader &&
      packet.rubric?.version === goVisibilityVersion &&
      Buffer.byteLength(serialized) === wire &&
      t.wire_sha256 === sha(serialized) &&
      t.wire_sha256 === d.wire_sha256 &&
      typeof t.binding_metadata_utf8 === "string" &&
      t.binding_metadata_utf8 === d.binding_metadata_utf8 &&
      sha(t.binding_metadata_utf8) === t.metadata_sha256 &&
      isDeepStrictEqual(JSON.parse(t.binding_metadata_utf8), bindingMetadata) &&
      hex(t.metadata_sha256) &&
      t.metadata_sha256 === d.metadata_sha256 &&
      Number.isInteger(t.batch) &&
      t.batch >= 1 &&
      t.batch <= 6 &&
      d.batch === t.batch &&
      Number.isInteger(t.slot) &&
      (supplement
        ? t.batch === 1 && t.slot === supplementSlots[supplement.route]
        : calibrated
          ? t.slot === 6
          : t.slot >= 8 && t.slot <= 99) &&
      d.slot === t.slot &&
      t.raw_sha256 === sha(raw) &&
      t.charged_usd === null &&
      t.calculated_charge_usd == null &&
      t.pricing_window === null &&
      t.status === t.http_status &&
      isDeepStrictEqual(t.go_catalog, d.go_catalog) &&
      snapshot(t.go_catalog, policy.models_endpoint) &&
      t.go_catalog.data?.id === policy.model &&
      t.go_catalog.data?.canonical_id === policy.canonical_id &&
      t.go_catalog.data.reasoning_supported === true &&
      Array.isArray(t.go_catalog.data.reasoning_efforts) &&
      t.go_catalog.data.reasoning_efforts.includes("max") &&
      Number.isSafeInteger(t.go_catalog.data.output_token_limit) &&
      t.go_catalog.data.output_token_limit >= policy.max_output_tokens &&
      isDeepStrictEqual(t.go_usage_before, d.go_usage_before) &&
      windows(t.go_usage_before, !continuation) &&
      (continuation || t.go_headroom?.admitted === true) &&
      isDeepStrictEqual(
        t.go_local_unreflected_usd,
        d.go_local_unreflected_usd,
      ) &&
      isDeepStrictEqual(t.go_headroom, d.go_headroom) &&
      isDeepStrictEqual(
        t.go_headroom,
        goHeadroom(t.go_usage_before, calibrated, t.go_local_unreflected_usd),
      ) &&
      (calibrated ||
        ([policy.model, policy.canonical_id].includes(
          t.calibration_returned_model,
        ) &&
          t.calibration_returned_model === d.calibration_returned_model &&
          t.calibration_native_at === d.calibration_native_at &&
          calibrationAgeOK(t.calibration_native_at, t.created))) &&
      Number.isFinite(Date.parse(t.created)) &&
      d.created === t.created &&
      Date.parse(t.finished) >= Date.parse(t.created) &&
      typeof t.quota_stop === "boolean" &&
      (windows(t.go_usage_after, !continuation) || t.quota_stop ||
        (continuation && t.go_usage_after === null && typeof t.go_usage_after_error === "string")) &&
      (![401, 402, 403, 429].includes(t.http_status) || t.quota_stop),
    "STAGE_C_GO_READER_BINDING",
  );
  const evidence_sha256 = sha(gradeJSONBytes(envelope));
  if (!continuation && t.go_billing_source === "balance") {
    requireThat(t.quota_stop === true, "STAGE_C_GO_BALANCE_BILLING_HOLD");
    return { rejected: "BALANCE_BILLING", evidence_sha256 };
  }
  if (
    raw === "" &&
    (t.http_status === null ||
      (Number.isInteger(t.http_status) &&
        t.http_status >= 400 &&
        t.http_status < 600))
  )
    return { mechanical: "NO_RESPONSE", evidence_sha256 };
  requireThat(
    t.http_status === 200 && typeof t.returned_model === "string",
    "STAGE_C_GO_RESPONSE",
  );
  const u = t.usage;
  requireThat(
    u &&
      [u.prompt_tokens, u.completion_tokens, u.total_tokens].every(
        (v) => Number.isSafeInteger(v) && v >= 0,
      ) &&
      u.prompt_tokens > 0 &&
      u.prompt_tokens <= wire &&
      u.completion_tokens <= policy.max_output_tokens &&
      u.total_tokens === u.prompt_tokens + u.completion_tokens,
    "STAGE_C_GO_TOKEN_USAGE",
  );
  if (
    ![policy.model, policy.canonical_id].includes(t.returned_model) ||
    (!calibrated && t.returned_model !== t.calibration_returned_model)
  )
    return { rejected: "RETURNED_MODEL_MISMATCH", evidence_sha256 };
  if (t.finish_reason === "length")
    return { mechanical: "TRUNCATED_RESPONSE", evidence_sha256 };
  if (!raw.trim()) return { mechanical: "NO_RESPONSE", evidence_sha256 };
  if (t.finish_reason !== "stop")
    return { mechanical: "UNEXPECTED_FINISH", evidence_sha256 };
  try {
    return JSON.parse(
      raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1"),
    );
  } catch {
    return { mechanical: "INVALID_JSON", evidence_sha256 };
  }
}

export function goMetering(transport: any) {
  return {
    slot: transport.slot,
    batch: transport.batch,
    wire_sha256: transport.wire_sha256,
    packet_sha256: transport.packet_sha256,
    input_sha256: transport.input_sha256,
    inference_dispatches: transport.inference_dispatches,
    billing_basis: policy.billing_basis,
    charged_usd: null,
    reported_cost: transport.go_reported_cost ?? null,
    reported_cash_usd: transport.go_reported_cash_usd ?? null,
    billing_source: transport.go_billing_source ?? null,
    list_cost_usd: transport.go_list_cost_usd ?? null,
    cost_estimated: transport.go_cost_estimated ?? null,
    allowance: transport.go_allowance ?? null,
    usage: transport.usage ?? null,
    usage_before: transport.go_usage_before,
    usage_after: transport.go_usage_after,
    request_model: transport.model,
    returned_model: transport.returned_model ?? null,
    response_id: transport.response_id ?? null,
    catalog: transport.go_catalog,
    observed_identity: transport.go_response_identity ?? {},
    system_fingerprints: transport.response_system_fingerprints ?? [],
    quota_stop: transport.quota_stop,
    headroom: transport.go_headroom,
    calibration_native_at: transport.calibration_native_at ?? null,
    calibration_returned_model: transport.calibration_returned_model ?? null,
  };
}

export function confirmGoOrigin(
  packetBytes: Buffer,
  keyBytes: Buffer,
  resultBytes: Buffer,
  transportBytes: Buffer,
  origin: GoCalibrationOrigin,
  sourcePartition = 5,
) {
  requireThat(
    origin &&
      [
        "freeze_sha256",
        "archive_sha256",
        "receipt_sha256",
        "packet_sha256",
        "key_sha256",
        "rubric_sha256",
        "transport_sha256",
      ].every((k) => hex(origin[k as keyof GoCalibrationOrigin])) &&
      sha(packetBytes) === origin.packet_sha256 &&
      sha(keyBytes) === origin.key_sha256 &&
      sha(resultBytes) === origin.receipt_sha256 &&
      sha(transportBytes) === origin.transport_sha256,
    "STAGE_C_GO_ORIGIN_DIGEST",
  );
  const packet = JSON.parse(packetBytes.toString()),
    key = JSON.parse(keyBytes.toString()),
    result = JSON.parse(resultBytes.toString());
  const controls = packet.controls,
    envelope = result.reader_evidence,
    transport = JSON.parse(transportBytes.toString());
  requireThat(
    sha(gradeJSONBytes(packet.rubric)) === origin.rubric_sha256 &&
      result.status === "PASSED" &&
      transport.batch === sourcePartition - 1 &&
      isDeepStrictEqual(transport, envelope?.transport) &&
      result.reader_query_sha256 === sha(admittedReaderQuery(packet)),
    "STAGE_C_GO_ORIGIN_RECEIPT",
  );
  const mark = goReaderResponse(envelope, packet, origin.freeze_sha256);
  requireThat(
    Array.isArray(controls) &&
      Array.isArray(key) &&
      controls.length === 28 &&
      key.length === 28 &&
      new Set(controls.map((c: any) => c.id)).size === 28 &&
      new Set(key.map((k: any) => k.id)).size === 28 &&
      controls.filter((c: any) => c.assertion === "visibility").length === 6 &&
      mark?.packet_sha256 === origin.packet_sha256 &&
      mark?.judge?.provider === policy.provider &&
      mark?.judge?.model === policy.model &&
      mark.judge.reasoning_effort === policy.reasoning_effort &&
      Array.isArray(mark.labels) &&
      mark.labels.length === 28 &&
      key.every(
        (k: any) =>
          controls.some((c: any) => c.id === k.id) &&
          mark.labels.filter(
            (x: any) => x.id === k.id && x.verdict === k.expected,
          ).length === 1,
      ) &&
      isDeepStrictEqual(mark, result.submission) &&
      result.response_sha256 === sha(gradeJSONBytes(mark)),
    "STAGE_C_GO_ORIGIN_CALIBRATION",
  );
}

const sources = [
  ["blind.json", "blind.json"],
  ["key.json", "key.json"],
  ["attempt-1-result.json", "go-origin-result.json"],
  ["a-transport.json", "go-origin-transport.json"],
] as const;

export type GoCalibrationPending = Pick<
  GoCalibrationOrigin,
  "freeze_sha256" | "packet_sha256" | "key_sha256" | "rubric_sha256"
>;
export type GoCalibrationFailure = GoCalibrationPending & {
  archive_sha256: string;
  receipt_sha256: string | null;
  status: string;
};

const pendingKeys = [
  "freeze_sha256",
  "packet_sha256",
  "key_sha256",
  "rubric_sha256",
] as const;
function verifyPendingBytes(
  packet: Buffer,
  key: Buffer,
  pending: GoCalibrationPending,
) {
  const p = JSON.parse(packet.toString()),
    k = JSON.parse(key.toString());
  requireThat(
    pending &&
      Object.keys(pending).length === pendingKeys.length &&
      pendingKeys.every((n) => hex(pending[n])) &&
      sha(packet) === pending.packet_sha256 &&
      sha(key) === pending.key_sha256 &&
      sha(gradeJSONBytes(p.rubric)) === pending.rubric_sha256 &&
      p.rubric.reader === goReader &&
      p.rubric.version === goVisibilityVersion &&
      Array.isArray(p.controls) &&
      p.controls.length === 28 &&
      Array.isArray(k) &&
      k.length === 28,
    "STAGE_C_GO_PENDING_TEMPLATE",
  );
}
function matchesPending(binding: any, pending: GoCalibrationPending) {
  return pendingKeys.every((k) => binding?.[k] === pending[k]);
}
function confirmFailure(
  failure: GoCalibrationFailure,
  pending: GoCalibrationPending,
) {
  requireThat(
    failure &&
      Object.keys(failure).length === 7 &&
      matchesPending(failure, pending) &&
      hex(failure.archive_sha256) &&
      (["FAILED", "REJECTED", "MECHANICAL"].includes(failure.status)
        ? hex(failure.receipt_sha256)
        : ["NOT_TESTED", "RESERVED"].includes(failure.status) &&
          failure.receipt_sha256 === null),
    "STAGE_C_GO_WITHHELD_SOURCE",
  );
}

export async function prepareGoCalibrationTemplate(
  root: string,
  blindBytes: Buffer,
  keyBytes: Buffer,
  pending: GoCalibrationPending,
) {
  verifyPendingBytes(blindBytes, keyBytes, pending);
  await Domains.use(root, async (d) => {
    const store = assertGradeStore(root);
    const files = [
      { name: dir + "/blind.json", content: blindBytes },
      { name: dir + "/key.json", content: keyBytes },
      { name: dir + "/go-pending.json", content: gradeJSONBytes(pending) },
    ];
    if (
      files.every(
        (f) =>
          store.has(f.name) &&
          readOwnedGradeFile(root, f.name).equals(f.content),
      )
    )
      return;
    requireThat(
      files.every((f) => !store.has(f.name)) &&
        !store.has(dir + "/attempt-1.json"),
      "STAGE_C_GO_TEMPLATE_CONFLICT",
    );
    commitGradeFiles(
      root,
      d.assertControllerLease(),
      "completion-go-calibration-template",
      files,
    );
  });
  return { kind: "PENDING", pending, inference_dispatches: 0 };
}

export function verifyGoCalibrationTemplate(root: string, inputs: any) {
  const c = inputs?.go_continuation,
    pending = c?.pending_calibration,
    store = assertGradeStore(root);
  requireThat(
    c?.source_partition === 5 &&
      ([6, 7].includes(c?.partition) || residualParent(c)) &&
      !c.calibration_origin &&
      !c.calibration_withheld &&
      ["go-pending.json", "blind.json", "key.json"].every((n) =>
        store.has(dir + "/" + n),
      ) &&
      isDeepStrictEqual(
        readOwnedGradeJSON(root, dir + "/go-pending.json"),
        pending,
      ),
    "STAGE_C_GO_PENDING_BINDING",
  );
  verifyPendingBytes(
    readOwnedGradeFile(root, dir + "/blind.json"),
    readOwnedGradeFile(root, dir + "/key.json"),
    pending,
  );
  return { kind: "PENDING", pending, inference_dispatches: 0 };
}

export async function withholdGoCalibrationReference(
  root: string,
  inputs: any,
  failure: GoCalibrationFailure,
) {
  const { pending } = verifyGoCalibrationTemplate(root, inputs);
  confirmFailure(failure, pending);
  await Domains.use(root, async (d) => {
    const store = assertGradeStore(root),
      name = dir + "/go-withheld.json",
      content = gradeJSONBytes(failure);
    requireThat(
      !store.has(dir + "/go-origin.json") &&
        !store.has(dir + "/attempt-1.json"),
      "STAGE_C_GO_WITHHELD_CONFLICT",
    );
    if (store.has(name)) {
      requireThat(
        readOwnedGradeFile(root, name).equals(content),
        "STAGE_C_GO_WITHHELD_CONFLICT",
      );
      return;
    }
    commitGradeFiles(
      root,
      d.assertControllerLease(),
      "completion-go-calibration-withheld",
      [{ name, content }],
    );
  });
  return {
    kind: "WITHHELD",
    status: "NOT_TESTED",
    attempts: 0,
    receipt_sha256: null,
    inference_dispatches: 0,
    source_failure: failure,
  };
}

export function goCalibrationReportReference(root: string, inputs: any) {
  const store = assertGradeStore(root);
  if (
    inputs?.go_continuation?.pending_calibration &&
    store.has(dir + "/go-withheld.json")
  ) {
    const { pending } = verifyGoCalibrationTemplate(root, inputs);
    const failure = readOwnedGradeJSON(root, dir + "/go-withheld.json");
    confirmFailure(failure, pending);
    requireThat(
      !store.has(dir + "/go-origin.json") &&
        !store.has(dir + "/attempt-1.json"),
      "STAGE_C_GO_WITHHELD_CONFLICT",
    );
    return {
      kind: "WITHHELD",
      status: "NOT_TESTED",
      attempts: 0,
      receipt_sha256: null,
      inference_dispatches: 0,
      source_failure: failure,
    };
  }
  return verifyGoCalibrationReference(root, inputs);
}

export async function prepareGoCalibrationReference(
  root: string,
  sourceFilesDir: string,
  origin: GoCalibrationOrigin,
) {
  const bytes = sources.map(([name]) =>
    readOwnedGradeFile(sourceFilesDir, name),
  );
  confirmGoOrigin(bytes[0], bytes[1], bytes[2], bytes[3], origin);
  await Domains.use(root, async (d) => {
    const store = assertGradeStore(root),
      files = sources.map(([, name], i) => ({
        name: dir + "/" + name,
        content: bytes[i],
      }));
    files.push({
      name: dir + "/go-origin.json",
      content: gradeJSONBytes(origin),
    });
    requireThat(
      !store.has(dir + "/go-withheld.json") &&
        !store.has(dir + "/attempt-1.json"),
      "STAGE_C_GO_REFERENCE_CONFLICT",
    );
    if (store.has(dir + "/go-pending.json")) {
      const pending = readOwnedGradeJSON(root, dir + "/go-pending.json");
      verifyPendingBytes(bytes[0], bytes[1], pending);
      requireThat(
        matchesPending(origin, pending) &&
          files
            .slice(0, 2)
            .every(
              (f) =>
                store.has(f.name) &&
                readOwnedGradeFile(root, f.name).equals(f.content),
            ),
        "STAGE_C_GO_PENDING_BINDING",
      );
      files.splice(0, 2);
    }
    if (
      files.every(
        (f) =>
          store.has(f.name) &&
          readOwnedGradeFile(root, f.name).equals(f.content),
      )
    )
      return;
    requireThat(
      files.every((f) => !store.has(f.name)),
      "STAGE_C_GO_REFERENCE_CONFLICT",
    );
    commitGradeFiles(
      root,
      d.assertControllerLease(),
      "completion-go-calibration-reference",
      files,
    );
  });
  return {
    kind: "REFERENCE",
    status: "PASSED",
    inference_dispatches: 0,
    origin,
  };
}

export function verifyGoCalibrationReference(root: string, inputs: any) {
  const continuation = inputs?.go_continuation;
  requireThat(
    continuation &&
      !continuation.calibration_withheld &&
      continuation.source_partition === 5 &&
      ([6, 7].includes(continuation.partition) || residualParent(continuation)),
    "STAGE_C_GO_REFERENCE_BINDING",
  );
  requireThat(
    assertGradeStore(root).has(dir + "/go-origin.json"),
    "STAGE_C_GO_CALIBRATION_REFERENCE_PENDING_OR_WITHHELD",
  );
  const origin = readOwnedGradeJSON(root, dir + "/go-origin.json");
  if (continuation.pending_calibration) {
    const { pending } = verifyGoCalibrationTemplate(root, inputs);
    requireThat(
      matchesPending(origin, pending),
      "STAGE_C_GO_REFERENCE_BINDING",
    );
  } else
    requireThat(
      isDeepStrictEqual(origin, continuation.calibration_origin),
      "STAGE_C_GO_REFERENCE_BINDING",
    );
  const store = assertGradeStore(root);
  requireThat(
    !store.has(dir + "/go-withheld.json") &&
      !store.has(dir + "/attempt-1.json") &&
      [...sources.map(([, n]) => n), "go-origin.json"].every((n) =>
        store.has(dir + "/" + n),
      ),
    "STAGE_C_GO_REFERENCE_SCOPE",
  );
  const bytes = sources.map(([, name]) =>
    readOwnedGradeFile(root, dir + "/" + name),
  );
  confirmGoOrigin(bytes[0], bytes[1], bytes[2], bytes[3], origin);
  return {
    status: "PASSED",
    kind: "REFERENCE",
    inference_dispatches: 0,
    origin,
  };
}

export function goCandidateUsage(rows: any[]) {
  const observations = rows.flatMap((row) =>
    row.go_reader_metering ? [row.go_reader_metering] : [],
  );
  const metered = observations.filter(
    (m) =>
      m.usage &&
      Number.isSafeInteger(m.usage.prompt_tokens) &&
      Number.isSafeInteger(m.usage.completion_tokens),
  );
  return {
    billing_basis: policy.billing_basis,
    cash_charge_usd: null,
    inference_dispatches: observations.length,
    unsettled_reservations: rows.filter(
      (row) => row.assessment_attempts && !row.go_reader_metering,
    ).length,
    metered_responses: metered.length,
    prompt_tokens: metered.reduce((n, v) => n + v.usage.prompt_tokens, 0),
    completion_tokens: metered.reduce(
      (n, v) => n + v.usage.completion_tokens,
      0,
    ),
    observations,
  };
}

export function goGradeGate(continuation: any, calibration: boolean) {
  requireThat(
    continuation &&
      [5, 7].includes(continuation.source_partition) &&
      [5, 6, 7].includes(continuation.partition) &&
      continuation.partition >= continuation.source_partition,
    "STAGE_C_GO_PARTITION",
  );
  requireThat(
    continuation.calibration_withheld !== true,
    "STAGE_C_GO_CALIBRATION_WITHHELD",
  );
  const shared =
    continuation.partition !== continuation.source_partition ||
    residualParent(continuation);
  requireThat(
    !(shared && calibration),
    "STAGE_C_GO_SHARED_CALIBRATION_ALREADY_SCORED",
  );
  return shared;
}

/** Each read is additionally verified against its exact NAS archive manifest entry by archivedBatch. */
export function archivedGoAssessment(
  freeze: any,
  freezeHash: string,
  archiveHash: string,
  result: any,
  entries: ReadonlyMap<string, unknown>,
  readExport: (name: string, archived: string) => Buffer,
) {
  const c = freeze.go_continuation,
    grade = freeze.grade,
    base = "oracles/completion/";
  requireThat(
    c &&
      c.partition === freeze.batch_index &&
      [5, 7].includes(c.source_partition) &&
      [5, 6, 7].includes(c.partition) &&
      c.partition >= c.source_partition &&
      grade.reader === goReader &&
      grade.version === goVisibilityVersion &&
      isDeepStrictEqual(grade.transport, policy) &&
      grade.max_attempts === 1 &&
      result.freeze_sha256 === freezeHash &&
      Array.isArray(result.rows) &&
      result.billing_basis === policy.billing_basis &&
      result.cash_charge_usd === null &&
      result.candidate_reader_metered_usd === null &&
      [
        result.charged_usd,
        result.known_usd,
        result.unresolved_cost_reservation_usd,
      ].every((v) => v === null) &&
      [
        result.tariff_estimate_usd,
        result.tariff_guard_usd,
        result.unresolved_tariff_reservation_usd,
      ].every(number),
    "STAGE_C_GO_ARCHIVED_POLICY",
  );
  const files = (lane: string, name: string, transport = false) =>
    readExport(
      "go-reader/" + lane + "/" + name,
      (transport ? "reports/go-reader/" : base) + lane + "/" + name,
    );
  const parsed = (data: Buffer) => JSON.parse(data.toString());
  const laneNames = new Set(["calibration"]),
    slots = new Set<number>();
  function history(lane: string) {
    const prefix = base + lane + "/attempt-";
    for (const k of entries.keys())
      if (k.startsWith(prefix))
        requireThat(
          [prefix + "1.json", prefix + "1-result.json"].includes(k),
          "STAGE_C_GO_EXTRA_READER_ATTEMPT",
        );
    const reserved = entries.has(prefix + "1.json"),
      settled = entries.has(prefix + "1-result.json"),
      transported = entries.has(
        "reports/go-reader/" + lane + "/a-transport.json",
      );
    requireThat(
      (!settled || reserved) && settled === transported,
      "STAGE_C_GO_ARCHIVED_ATTEMPT",
    );
    return { reserved, settled };
  }
  function actual(lane: string, packet: Buffer) {
    const digest = sha(packet),
      reservation = parsed(files(lane, "attempt-1.json"));
    requireThat(
      reservation.number === 1 && reservation.packet_sha256 === digest,
      "STAGE_C_GO_RESERVATION",
    );
    const tBytes = files(lane, "a-transport.json", true),
      resultBytes = files(lane, "attempt-1-result.json"),
      r = parsed(resultBytes),
      t = parsed(tBytes),
      packetValue = parsed(packet),
      e = r.reader_evidence;
    requireThat(
      isDeepStrictEqual(t, e?.transport) &&
        t.batch === c.partition - 1 &&
        t.packet_sha256 === digest &&
        r.reader_query_sha256 === sha(admittedReaderQuery(packetValue)),
      "STAGE_C_GO_ARCHIVED_TRANSPORT",
    );
    let mark = goReaderResponse(e, packetValue, freezeHash);
    if (
      lane !== "calibration" &&
      mark?.visibility === "COLD" &&
      r.submission?.visibility === "OPAQUE"
    ) {
      const binding = parsed(files(lane, "binding.json"));
      requireThat(
        binding.surfaceComplete === false &&
          ["C16-combined", "C06-stale-cold"].includes(binding.scenario) &&
          mark.visibility_evidence?.includes(binding.coverage_id),
        "STAGE_C_GO_ARCHIVED_VISIBILITY",
      );
      mark = { ...mark, reader_visibility: "COLD", visibility: "OPAQUE" };
    }
    requireThat(
      isDeepStrictEqual(mark, r.submission) &&
        r.response_sha256 === sha(gradeJSONBytes(mark)) &&
        (mark?.mechanical
          ? r.status === "MECHANICAL"
          : mark?.rejected
            ? r.status === "REJECTED"
            : (lane === "calibration"
                ? ["PASSED", "FAILED", "REJECTED"]
                : ["ACCEPTED", "REJECTED"]
              ).includes(r.status)),
      "STAGE_C_GO_ARCHIVED_MARK",
    );
    return { t, r, tBytes, resultBytes };
  }
  const h = history("calibration"),
    packet = files("calibration", "blind.json"),
    key = files("calibration", "key.json"),
    proof = parsed(packet);
  requireThat(
    sha(packet) === grade.packet_sha256 &&
      sha(key) === grade.key_sha256 &&
      sha(gradeJSONBytes(proof.rubric)) === grade.rubric_sha256 &&
      proof.rubric.reader === goReader &&
      proof.rubric.version === goVisibilityVersion,
    "STAGE_C_GO_ARCHIVED_CALIBRATION",
  );
  const basics = {
    packet_sha256: sha(packet),
    receipt_sha256: null,
    attempts: 0,
    status: "NOT_TESTED",
    inference_dispatches: 0,
  };
  const pending = c.pending_calibration;
  if (pending) {
    requireThat(
      c.source_partition === 5 &&
        ([6, 7].includes(c.partition) || residualParent(c)) &&
        !c.calibration_origin &&
        !c.calibration_withheld &&
        isDeepStrictEqual(
          parsed(files("calibration", "go-pending.json")),
          pending,
        ),
      "STAGE_C_GO_PENDING_BINDING",
    );
    verifyPendingBytes(packet, key, pending);
  } else
    requireThat(
      !entries.has(base + "calibration/go-pending.json"),
      "STAGE_C_GO_PENDING_BINDING",
    );
  const failed = entries.has(base + "calibration/go-withheld.json");
  requireThat(!failed || pending, "STAGE_C_GO_WITHHELD_SOURCE");
  if (
    failed ||
    c.calibration_withheld ||
    (c.partition === c.source_partition && !residualParent(c))
  )
    requireThat(
      [
        "go-origin.json",
        "go-origin-result.json",
        "go-origin-transport.json",
      ].every((n) => !entries.has(base + "calibration/" + n)),
      "STAGE_C_GO_UNEXPECTED_ORIGIN",
    );
  let calibration: any;
  let sourceIdentity: ReturnType<typeof sourceCalibrationBinding> | undefined;
  if (failed) {
    const failure = parsed(files("calibration", "go-withheld.json"));
    confirmFailure(failure, pending);
    const ref = {
      kind: "WITHHELD",
      status: "NOT_TESTED",
      attempts: 0,
      receipt_sha256: null,
      inference_dispatches: 0,
      source_failure: failure,
    };
    requireThat(
      !h.reserved && isDeepStrictEqual(result.go_calibration_reference, ref),
      "STAGE_C_GO_WITHHELD_ATTEMPT",
    );
    calibration = { ...basics, ...ref };
  } else if (c.calibration_withheld) {
    requireThat(
      !h.reserved && !c.calibration_origin && !result.go_calibration_reference,
      "STAGE_C_GO_WITHHELD_ATTEMPT",
    );
    calibration = { ...basics, kind: "WITHHELD" };
  } else if (c.partition !== c.source_partition || residualParent(c)) {
    const origin = parsed(files("calibration", "go-origin.json"));
    requireThat(
      !h.reserved &&
        (pending
          ? matchesPending(origin, pending)
          : isDeepStrictEqual(origin, c.calibration_origin)),
      "STAGE_C_GO_REFERENCE_BINDING",
    );
    confirmGoOrigin(
      packet,
      key,
      files("calibration", "go-origin-result.json"),
      files("calibration", "go-origin-transport.json"),
      origin,
    );
    sourceIdentity = sourceCalibrationBinding(
      parsed(files("calibration", "go-origin-transport.json")),
    );
    const ref = {
      status: "PASSED",
      kind: "REFERENCE",
      inference_dispatches: 0,
      origin,
    };
    requireThat(
      isDeepStrictEqual(result.go_calibration_reference, ref),
      "STAGE_C_GO_REFERENCE_RESULT",
    );
    calibration = {
      ...basics,
      ...ref,
      ...sourceIdentity,
      receipt_sha256: origin.receipt_sha256,
    };
  } else {
    requireThat(
      !c.calibration_origin && !result.go_calibration_reference,
      "STAGE_C_GO_ORIGIN_SCOPE",
    );
    calibration = {
      ...basics,
      kind: "ORIGIN",
      attempts: Number(h.reserved),
      status: h.reserved ? "RESERVED" : "NOT_TESTED",
      inference_dispatches: h.reserved ? null : 0,
    };
    if (h.settled) {
      const { r, t, tBytes, resultBytes } = actual("calibration", packet);
      Object.assign(calibration, {
        status: r.status,
        receipt_sha256: sha(resultBytes),
        inference_dispatches: 1,
        go_reader_metering: goMetering(t),
      });
      if (r.status === "PASSED") {
        const origin = {
          freeze_sha256: freezeHash,
          archive_sha256: archiveHash,
          packet_sha256: sha(packet),
          key_sha256: sha(key),
          rubric_sha256: grade.rubric_sha256,
          receipt_sha256: sha(resultBytes),
          transport_sha256: sha(tBytes),
        };
        confirmGoOrigin(
          packet,
          key,
          resultBytes,
          tBytes,
          origin,
          c.source_partition,
        );
        sourceIdentity = sourceCalibrationBinding(t);
        Object.assign(calibration, sourceIdentity);
        calibration.origin = origin;
      }
    }
  }
  for (const row of result.rows) {
    requireThat(
      typeof row.source_lineage === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(row.source_lineage) &&
        row.reader_metered_usd === undefined &&
        row.reader_disputed_usd === undefined,
      "STAGE_C_GO_ARCHIVED_LANE",
    );
    const lane = row.source_lineage + (row.pair_position === "B" ? "-B" : "");
    requireThat(!laneNames.has(lane), "STAGE_C_GO_ARCHIVED_LANE");
    laneNames.add(lane);
    const r = history(lane);
    requireThat(
      row.assessment_attempts === Number(r.reserved) &&
        (!r.reserved || calibration.status === "PASSED"),
      "STAGE_C_GO_ARCHIVED_RESERVATION",
    );
    if (r.settled) {
      const receipt = actual(lane, files(lane, "blind.json")),
        slot = receipt.t.slot;
      requireThat(
        sourceIdentity &&
          receipt.t.calibration_native_at ===
            sourceIdentity.calibration_native_at &&
          receipt.t.calibration_returned_model ===
            sourceIdentity.calibration_returned_model &&
          !slots.has(slot) &&
          row.assessment_status === receipt.r.status &&
          isDeepStrictEqual(row.go_reader_metering, goMetering(receipt.t)),
        "STAGE_C_GO_ARCHIVED_CANDIDATE",
      );
      slots.add(slot);
    } else
      requireThat(
        row.assessment_status === "NOT_TESTED" && !row.go_reader_metering,
        "STAGE_C_GO_UNSETTLED",
      );
  }
  for (const name of entries.keys()) {
    const match =
      /^(?:oracles\/completion\/([^/]+)\/attempt-|reports\/go-reader\/([^/]+)\/a-transport\.json$)/.exec(
        name,
      );
    if (match)
      requireThat(
        laneNames.has(match[1] ?? match[2]),
        "STAGE_C_GO_UNDECLARED_LANE",
      );
  }
  requireThat(
    isDeepStrictEqual(
      result.candidate_reader_go,
      goCandidateUsage(result.rows),
    ),
    "STAGE_C_GO_ARCHIVED_USAGE",
  );
  return { result, calibration };
}
