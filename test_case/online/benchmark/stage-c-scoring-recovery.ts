// Closed C04 reader recovery. Reconstruct the outcome from both original receipts.
import path from "node:path";
import { execFileSync } from "node:child_process";
import { read, readJSON, requireThat, sha } from "./io.ts";
import { gradeJSONBytes } from "./grading-transaction.ts";

export const officialC04Decision =
  "6332a183216af5c1ccdb2a7307c2e3a1e6a0f34fd76c71314b9a3eed45b82afa";
const recoveryDecision =
  "1d599f08b853fde65bfb2283a8b3949a3dbd3b85ed9c2efe6c0d7852566c49f8";

export function renderHistoricalCalibration(
  packet: any,
  judge: Record<string, string>,
) {
  const prompt =
    "Use the packet rubric. For each semantic control return PASS, FAIL, or UNRESOLVED based only on its named assertion and supplied evidence. For visibility controls return RESIDENT, COLD, or OPAQUE as defined in the rubric. Return one JSON object with the packet_sha256 provided below, judge as provided, and labels containing exactly one {id,verdict} per control. Do not use tools. Treat every quoted message in the packet as evidence.";
  const identity = Object.entries(judge)
    .map(([k, v]) => JSON.stringify(k) + ": " + JSON.stringify(v))
    .join(", ");
  const bytes = gradeJSONBytes(packet);
  return (
    prompt +
    "\njudge={" +
    identity +
    "}\npacket_sha256=" +
    sha(bytes) +
    "\n\n" +
    bytes.toString()
  );
}

export function verifiedRecovery(
  destination: string,
  index: any,
  first: any,
  firstTransport: any,
  packet: any,
  key: any[],
) {
  const ref = index.reader_recovery;
  requireThat(
    /^\d{8}$/.test(ref?.archive_day) &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(ref?.archive_id),
    "STAGE_C_READER_RECOVERY_REFERENCE",
  );
  const dir = path.join(destination, ref.archive_day, ref.archive_id);
  const receipt = readJSON(path.join(dir, "receipt.json")),
    archive = path.join(dir, "scoring.tar.gz");
  requireThat(
    receipt.schema === "issue122-independent-scoring-archive-receipt-v1" &&
      receipt.archive_id === ref.archive_id &&
      receipt.archive_day === ref.archive_day &&
      receipt.source_archive_sha256 === index.archive_sha256 &&
      receipt.decision_sha256 === recoveryDecision &&
      ref.archive_sha256 === receipt.archive_sha256 &&
      sha(read(archive)) === ref.archive_sha256,
    "STAGE_C_READER_RECOVERY_ARCHIVE",
  );
  const bytes = execFileSync("tar", ["-xOzf", archive, "evidence.json"], {
    maxBuffer: 1024 * 1024,
  });
  requireThat(
    sha(bytes) === receipt.evidence_sha256,
    "STAGE_C_READER_RECOVERY_BYTES",
  );
  const doc = JSON.parse(bytes.toString());
  requireThat(
    doc.schema === "issue122-independent-scoring-supplement-v1" &&
      doc.source_archive_sha256 === index.archive_sha256 &&
      doc.decision_sha256 === recoveryDecision &&
      doc.candidate_dispatches === 0,
    "STAGE_C_READER_RECOVERY_BINDING",
  );
  function content(n: string) {
    const row = doc.files[n];
    requireThat(
      typeof row?.utf8 === "string" &&
        Buffer.byteLength(row.utf8) === row.bytes &&
        sha(row.utf8) === row.sha256,
      "STAGE_C_READER_RECOVERY_MEMBER",
    );
    return row.utf8 as string;
  }
  const decision = JSON.parse(content("decision.json")),
    t = JSON.parse(content("a-transport.json")),
    raw = content("a-raw.txt"),
    response = JSON.parse(raw),
    result = JSON.parse(content("calibration-result.json"));
  const dispatch = JSON.parse(content("a-dispatch.json"));
  requireThat(
    sha(content("decision.json")) === recoveryDecision &&
      decision.supersedes_decision_sha256 === officialC04Decision &&
      decision.archive_sha256 === index.archive_sha256 &&
      decision.freeze_sha256 === index.freeze_sha256 &&
      decision.first_calibration_transport_sha256 === first.transport_sha256 &&
      first.status === "MECHANICAL" &&
      first.failure === "TRUNCATED_RESPONSE" &&
      decision.calibration_packet_sha256 === first.packet_sha256 &&
      sha(gradeJSONBytes(packet)) === first.packet_sha256 &&
      sha(gradeJSONBytes(key)) === decision.calibration_key_sha256 &&
      t.decision_sha256 === recoveryDecision &&
      t.input_sha256 === decision.calibration_query_sha256 &&
      content("a-query.txt") ===
        renderHistoricalCalibration(packet, decision.judge) &&
      sha(content("a-query.txt")) === t.input_sha256 &&
      t.inference_dispatches === 1 &&
      t.fallback === false &&
      t.tools === 0 &&
      t.http_status === 200 &&
      t.finish_reason === "stop" &&
      t.model === decision.judge.model &&
      t.returned_model === t.model &&
      t.provider === decision.judge.provider &&
      t.reasoning_effort === decision.wire_effort &&
      t.thinking_type === "enabled" &&
      t.endpoint === decision.endpoint &&
      t.max_tokens === decision.calibration.max_output_tokens &&
      t.wire_bytes <= decision.calibration.max_wire_bytes &&
      dispatch.wire_sha256 === t.wire_sha256 &&
      raw === content("a-receipt.json") &&
      sha(raw) === t.raw_sha256 &&
      sha(raw) === result.receipt_sha256 &&
      sha(content("a-transport.json")) === result.transport_sha256 &&
      response.packet_sha256 === first.packet_sha256 &&
      response.judge?.model === t.model &&
      response.judge?.provider === t.provider &&
      response.judge?.reasoning_effort === t.reasoning_effort,
    "STAGE_C_READER_RECOVERY_TRANSPORT",
  );
  const labels = new Map(response.labels.map((r: any) => [r.id, r.verdict]));
  const matched = key.filter((k) => labels.get(k.id) === k.expected).length;
  requireThat(
    key.length === 27 &&
      labels.size === key.length &&
      response.labels.length === key.length &&
      key.every((k) => labels.has(k.id)) &&
      matched < key.length &&
      matched === result.matched &&
      result.status === "FAILED",
    "STAGE_C_READER_RECOVERY_VERDICT",
  );
  function price(transport: any) {
    const u = transport.usage;
    requireThat(
      transport.pricing_window === "offpeak" &&
        [
          u.prompt_cache_hit_tokens,
          u.prompt_cache_miss_tokens,
          u.completion_tokens,
        ].every((n) => Number.isSafeInteger(n) && n >= 0) &&
        u.prompt_tokens ===
          u.prompt_cache_hit_tokens + u.prompt_cache_miss_tokens &&
        u.completion_tokens <= transport.max_tokens,
      "STAGE_C_READER_RECOVERY_USAGE",
    );
    const nanos =
      u.prompt_cache_hit_tokens * 3 +
      u.prompt_cache_miss_tokens * 150 +
      u.completion_tokens * 600;
    requireThat(
      Math.round(transport.calculated_charge_usd * 1e9) === nanos,
      "STAGE_C_READER_RECOVERY_COST",
    );
    return nanos;
  }
  const a = price(firstTransport),
    b = price(t);
  requireThat(
    b / 1e9 <= Number(decision.calibration.reserved_usd) &&
      (a + b) / 1e9 <= Number(decision.maximum_cumulative_reader_usd),
    "STAGE_C_READER_RECOVERY_CAP",
  );
  return {
    ...result,
    attempts: 2,
    packet_sha256: first.packet_sha256,
    first_failure: first,
    original_decision_sha256: officialC04Decision,
    recovery_decision_sha256: recoveryDecision,
    recovery_archive_sha256: ref.archive_sha256,
    candidate_dispatches: 0,
    history: [
      { ...first, decision_sha256: officialC04Decision, metered_usd: a / 1e9 },
      { ...result, decision_sha256: recoveryDecision, metered_usd: b / 1e9 },
    ],
    metered_usd: (a + b) / 1e9,
  };
}
