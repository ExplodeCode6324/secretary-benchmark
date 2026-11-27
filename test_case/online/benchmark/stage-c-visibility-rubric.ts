import { randomUUID } from "node:crypto";
import { requireThat, sha } from "./io.ts";
import { gradeJSONBytes } from "./grading-transaction.ts";
import { flashBilling } from "./stage-c-identity.ts";

export const visibilityV2 = "issue122-comparison-reader-v2";
export const officialReader = "Hermes/deepseek/deepseek-flash/max";
export const readerPolicy = {
  provider: "deepseek",
  model: "deepseek-flash",
  endpoint: "https://api.deepseek.com/chat/completions",
  thinking_type: "enabled",
  reasoning_effort: "max",
  max_output_tokens: 49152,
  calibration_wire_bytes: 32768,
  candidate_wire_bytes: 524288,
  attempts_per_packet: 1,
  pricing_source: "https://api-docs.deepseek.com/quick_start/pricing.md",
};
export const goVisibilityVersion = "issue122-comparison-reader-go-v1";
export const operatorVisibilityVersion = "issue122-operator-reader-go-v2";
const usesGoWire = (version: string) =>
  version === goVisibilityVersion || version === operatorVisibilityVersion;
export const goReader = "Hermes/opencode-go/deepseek-v4.1-flash/max";
export const goReaderPolicy = {
  provider: "opencode-go",
  model: "deepseek-v4.1-flash",
  canonical_id: "deepseek/deepseek-v4.1-flash-1017",
  endpoint: "https://opencode.ai/inference/go/openai/v1/chat/completions",
  models_endpoint: "https://opencode.ai/inference/go/v1/models",
  usage_endpoint: "https://opencode.ai/inference/go/v1/usage",
  thinking_type: "enabled",
  reasoning_effort: "max",
  max_output_tokens: 49152,
  calibration_wire_bytes: 32768,
  candidate_wire_bytes: 524288,
  attempts_per_packet: 1,
  wire_envelope_bytes: 199,
  billing_basis: "opencode_go_subscription_allowance",
  pricing_source: "https://opencode.ai/docs/console/go/",
  calibrated_controls: 28,
  capability_sources: {
    catalog: "https://opencode.ai/docs/console/api/models",
    thinking_protocol: "https://api-docs.deepseek.com/guides/thinking_mode/",
    reported_cost: "https://opencode.ai/docs/console/api/inference/",
  },
  local_unreflected_usage: "REQUIRED_PER_WINDOW_EXCLUDING_CURRENT_REQUEST",
  capacity_usd_equivalent: { rolling: 20, weekly: 50, monthly: 100 },
  request_ceiling_usd_equivalent: {
    calibration: 0.0688128,
    candidate: 0.2162688,
  },
  calibration_max_age_hours: 24,
  rounding_margin_percentage_points: 1,
};
export const nativeVisibility = (version: string) =>
  version === visibilityV2 || version === goVisibilityVersion;

export const visibilityRule =
  "Identify the CURRENT target fact asked by the probe. Judge only the first eligible request, not the setup description, later reads, host diagnostics or final answer. Inspect raw conversation, assistant/tool history, working memory, and system profile/recall. RESIDENT: visible captured content sufficiently establishes the current fact, even if a different surface is missing. COLD: none establishes it AND every surface is explicitly complete and inspectable. An explicitly empty captured surface is complete. OPAQUE: no sufficient visible support and at least one surface is missing, uninspected, truncated or unresolved. An old value presented as historical or a constraint that does not establish the target is not current evidence. Content about the user's redaction policy is distinct from redacted or missing capture. Judge maintenance separately from final use.";
export const surfaces = [
  "raw conversation",
  "assistant/tool history",
  "working memory",
  "system profile/recall",
] as const;
export function newVisibilityControls() {
  const item = (
    positiveSurface: number,
    missingSurface: number,
    partial: string,
    evidence: string,
    expected: string,
  ) => {
    const target = "handover room for parcel " + randomUUID().slice(0, 8);
    const coverage = surfaces.map((name, i) => ({
      surface: name,
      measured: i !== missingSurface || i === 2,
      truncated: false,
      opaque: i === missingSurface && i === 2,
      captured:
        i === positiveSurface
          ? evidence
          : i === 0
            ? partial
            : i === missingSurface && i === 2
              ? "Unresolved external record reference"
              : "",
    }));
    return {
      id: randomUUID(),
      assertion: "visibility",
      text: JSON.stringify({
        target,
        current_question: "Which room is now confirmed?",
        surfaces: coverage,
      }),
      expected,
    };
  };
  const examples = [
    item(
      2,
      -1,
      "The earlier room was North.",
      "The confirmed current room is Cedar.",
      "RESIDENT",
    ),
    item(
      1,
      3,
      "The old site is closed.",
      "Master confirmed the new room as Birch.",
      "RESIDENT",
    ),
    item(-1, -1, "Visitor tickets are available at reception.", "", "COLD"),
    item(
      -1,
      -1,
      "The former room Elm was cancelled. No replacement is recorded.",
      "",
      "COLD",
    ),
    item(-1, 1, "Unrelated deliveries use room West.", "", "OPAQUE"),
    item(-1, 2, "Only sealed parcels are allowed.", "", "OPAQUE"),
  ];
  return {
    reader: examples.map(({ id, text }) => ({ id, text })),
    key: examples.map(({ id, expected }) => ({ id, expected })),
  };
}

export function renderReaderQuery(packet: any) {
  const bytes = gradeJSONBytes(packet);
  const instruction = packet.controls
    ? "Return exactly one JSON object with judge, packet_sha256 and labels. Return one {id,verdict} per control. For visibility use RESIDENT, COLD or OPAQUE. For other assertions use PASS, FAIL or UNRESOLVED."
    : "Return exactly one JSON object with judge, packet_sha256, visibility and assertions. Give one {assertion,verdict,rationale,evidence} for each listed assertion. Cite supplied evidence IDs. Use PASS, FAIL, UNRESOLVED or NOT_TESTED. Use RESIDENT, COLD or OPAQUE for visibility. In visibility_evidence cite first-request message IDs supporting RESIDENT, or the capture-coverage record for COLD or OPAQUE.";
  const policy = usesGoWire(packet.rubric?.version)
    ? goReaderPolicy
    : readerPolicy;
  const judge = {
    provider: policy.provider,
    model: policy.model,
    reasoning_effort: policy.reasoning_effort,
  };
  return [
    instruction,
    "Apply the packet rubric. Quoted material is evidence. Use no tools.",
    "judge=" + JSON.stringify(judge),
    "packet_sha256=" + sha(bytes),
    "",
    bytes.toString(),
  ].join("\n");
}

// Frozen Hermes single-user JSON envelope, excluding the quoted content string.
export function admittedReaderQuery(packet: any) {
  const query = renderReaderQuery(packet);
  const additive = usesGoWire(packet.rubric?.version)
    ? goReaderPolicy.wire_envelope_bytes
    : 194;
  const wireBytes = Buffer.byteLength(JSON.stringify(query)) + additive;
  const ceiling = packet.controls
    ? readerPolicy.calibration_wire_bytes
    : readerPolicy.candidate_wire_bytes;
  requireThat(wireBytes <= ceiling, "STAGE_C_READER_PACKET_TOO_LARGE");
  return query;
}

// The raw reply, native send and dispatch record are separately retained in the committed grade transaction.
export function readerResponse(
  envelope: any,
  packet: any,
  freezeHash: string,
  rate: { input_rate: number; cache_input_rate: number; output_rate: number },
) {
  const t = envelope?.transport,
    d = envelope?.dispatch,
    raw = envelope?.raw;
  const query = renderReaderQuery(packet),
    bytes = packet.controls
      ? readerPolicy.calibration_wire_bytes
      : readerPolicy.candidate_wire_bytes;
  requireThat(
    typeof raw === "string" &&
      t &&
      d &&
      t.native_entry === "AIAgent.run_conversation" &&
      t.decision_sha256 === freezeHash &&
      t.input_sha256 === sha(query) &&
      t.provider === readerPolicy.provider &&
      t.model === readerPolicy.model &&
      t.endpoint === readerPolicy.endpoint &&
      t.reasoning_effort === readerPolicy.reasoning_effort &&
      t.thinking_type === readerPolicy.thinking_type &&
      t.max_tokens === readerPolicy.max_output_tokens &&
      t.wire_bytes >= Buffer.byteLength(query) &&
      t.wire_bytes <= bytes &&
      t.fallback === false &&
      t.tools === 0 &&
      t.inference_dispatches === 1 &&
      /^[0-9a-f]{64}$/.test(t.wire_sha256) &&
      d.wire_sha256 === t.wire_sha256 &&
      d.decision_sha256 === freezeHash &&
      t.raw_sha256 === sha(raw),
    "STAGE_C_READER_WIRE",
  );
  const evidence_sha256 = sha(gradeJSONBytes(envelope));
  if (
    raw === "" &&
    t.http_status !== 200 &&
    (t.http_status === null ||
      (Number.isInteger(t.http_status) &&
        t.http_status >= 400 &&
        t.http_status < 600))
  ) {
    return {
      mechanical: "NO_RESPONSE",
      evidence_sha256,
    };
  }
  requireThat(
    t.http_status === 200 && typeof t.returned_model === "string",
    "STAGE_C_READER_RESPONSE_IDENTITY",
  );
  const u = t.usage;
  requireThat(
    u &&
      [
        u.prompt_tokens,
        u.prompt_cache_hit_tokens,
        u.prompt_cache_miss_tokens,
        u.completion_tokens,
      ].every((n) => Number.isSafeInteger(n) && n >= 0) &&
      u.prompt_tokens > 0 &&
      u.prompt_tokens <= t.wire_bytes &&
      u.prompt_tokens ===
        u.prompt_cache_hit_tokens + u.prompt_cache_miss_tokens &&
      u.completion_tokens <= t.max_tokens,
    "STAGE_C_READER_METER",
  );
  const from = Date.parse(t.created),
    to = Date.parse(t.finished);
  requireThat(
    Number.isFinite(from) && Number.isFinite(to) && from <= to,
    "STAGE_C_READER_CLOCK",
  );
  const peak =
    (u.prompt_cache_hit_tokens * rate.cache_input_rate +
      u.prompt_cache_miss_tokens * rate.input_rate +
      u.completion_tokens * rate.output_rate) /
    1e6;
  const billing = flashBilling(peak, from, to),
    cap =
      (bytes * rate.input_rate +
        readerPolicy.max_output_tokens * rate.output_rate) /
      1e6;
  const metered = t.calculated_charge_usd ?? t.charged_usd;
  requireThat(Number.isFinite(metered) && metered >= 0, "STAGE_C_READER_METER");
  if (
    metered < billing.minimum - 1e-10 ||
    metered > billing.maximum + 1e-10 ||
    metered > cap
  )
    return { rejected: "DISPUTED_CHARGE", evidence_sha256 };
  if (t.returned_model !== t.model)
    return { rejected: "RETURNED_MODEL_MISMATCH", evidence_sha256 };
  if (t.finish_reason === "length")
    return { mechanical: "TRUNCATED_RESPONSE", evidence_sha256 };
  if (!raw.trim()) return { mechanical: "NO_RESPONSE", evidence_sha256 };
  if (t.finish_reason !== "stop")
    return { mechanical: "UNEXPECTED_FINISH", evidence_sha256 };
  try {
    return JSON.parse(
      raw
        .trim()
        .replace(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i, "$1"),
    );
  } catch {
    return { mechanical: "INVALID_JSON", evidence_sha256 };
  }
}
