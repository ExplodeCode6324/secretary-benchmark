import { sourceReads, judgeCorrection } from "./stage-c-reader.ts";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CoreClient } from "../../../sut/secretary/src/pi_secretary/src/core-client.ts";
import { stableID } from "../../../sut/secretary/src/pi_secretary/src/execution-utils.ts";
import { baselineCases } from "./baseline-scenarios.ts";
import { fillerTexts } from "./baseline-timeline.ts";
import { maintenanceBoundary } from "./baseline-evidence.ts";
import { type Run } from "./domain.ts";
import { sha, readJSON, requireThat, writeJSON, until } from "./io.ts";
import { snapshot } from "./snapshot.ts";
import { cas, wireVisibility } from "./stage-b-scenarios-evidence.ts";
import { captureBodies } from "./baseline-b0.ts";

export const coldCase = baselineCases(true).find(
  (c) => c.id === "C06-stale-cold",
)!;
const capMs = 600000;
export const fixturePrefix = { count: 8, bytes_each: 256, seed: 1220 };
type Frame = { records: any[]; events: any[] };
export function correctionBoundary(
  frames: Frame[],
  session: string,
  input: string,
  handled: number,
  deadline = Infinity,
) {
  const source = stableID("main.input.message:" + input);
  for (const [index, frame] of frames.entries()) {
    const job = frame.records.find(
      (r) =>
        r.record_type === "CompactionJob" &&
        r.session_id === session &&
        r.mode === "WORKING_MEMORY" &&
        r.state === "COMMITTED" &&
        (deadline === Infinity || Date.parse(r.updated_at) < deadline) &&
        r.source_end_sequence >= handled &&
        r.source_event_ids.includes(source),
    );
    if (!job) continue;
    const memory = frame.records.find(
      (r) =>
        r.record_type === "Consciousness" &&
        r.session_id === session &&
        r.last_job_id === job.id &&
        r.covered_event_sequence >= handled,
    );
    requireThat(memory, "C06_COVERING_REVISION_MISSING");
    return {
      index,
      job: job.id,
      revision: memory.revision,
      covered: memory.covered_event_sequence,
      source,
      items: memory.items,
    };
  }
  return null;
}
export function correctionSends(
  frames: Frame[],
  after: number,
  revision: number,
  session: string,
  probe: string,
  loop: string,
) {
  const contexts = frames
    .slice(after + 1)
    .flatMap((f) =>
      f.records.filter(
        (r) =>
          r.record_type === "Context" &&
          r.revision === 1 &&
          r.capture_kind === "MODEL_REQUEST" &&
          r.purpose === "MAIN" &&
          r.session_id === session,
      ),
    );
  const chain = contexts.filter(
    (r) => r.loop_id === loop && r.input_ids.includes(probe),
  );
  return {
    transition:
      contexts.find((r) => r.consciousness_revision >= revision) ?? null,
    first: chain[0]?.consciousness_revision >= revision ? chain[0] : null,
    chain,
  };
}
export function correctionControls() {
  const specifications = [
    ["Pick up on the day immediately preceding Sunday.", "RESIDENT"],
    [
      "Tool response repeated the most recent pickup day: Saturday.",
      "RESIDENT",
    ],
    ["No pickup date or restriction is present.", "COLD"],
    ["Thursday was the original proposed day. It is historical.", "COLD"],
    ["Only redacted material may be collected; no day is given.", "COLD"],
  ];
  const rows = specifications.map(([text, expected]) => ({
    id: randomUUID(),
    text,
    expected,
  }));
  return {
    reader: rows
      .map(({ id, text }) => ({ id, text }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    key: rows.map(({ id, expected }) => ({ id, expected })),
  };
}
export function checkReader(
  key: { id: string; expected: string }[],
  answer: { id: string; visibility: string }[],
) {
  requireThat(
    key.length === 5 &&
      answer.length === key.length &&
      new Set(answer.map((a) => a.id)).size === key.length &&
      key.every((k) =>
        answer.some((a) => a.id === k.id && a.visibility === k.expected),
      ),
    "C06_READER_CALIBRATION_FAILED",
  );
}

export async function fixtureMessage(run: Run, text: string, deadline: number) {
  requireThat(Date.now() < deadline, "C06_INPUT_DEADLINE");
  const request_id = randomUUID();
  const receipt = await new CoreClient(run.endpoint!).command("messages", {
    request_id,
    text,
  });
  const id = receipt.resource_ids.find((r) => r.type === "Input")?.id;
  requireThat(
    receipt.request_id === request_id &&
      receipt.acceptance === "ACCEPTED" &&
      id,
    "C06_INPUT_BINDING",
  );
  const observed = () => readJSON(path.join(run.evidence, "observed.json"));
  await until(
    () =>
      observed().input_records.some(
        (r: any) => r.id === id && r.state === "HANDLED",
      ),
    Math.max(1, deadline - Date.now()),
  );
  return id;
}
export async function exerciseCorrection(run: Run) {
  const core = path.join(run.active, "core");
  const observe = () => readJSON(path.join(run.evidence, "observed.json"));
  const a = await fixtureMessage(run, coldCase.setup[0], Date.now() + 30000);
  const b = await fixtureMessage(run, coldCase.setup[1], Date.now() + 30000);
  const session = observe().session_id;
  const handled = (frames: Frame[], input: string) =>
    frames
      .flatMap((f) => f.events)
      .find(
        (e) =>
          e.event_type === "input.handled" &&
          e.scope.session_id === session &&
          cas(core, e.payload).inputs.includes(input),
      );
  const base = snapshot(core);
  const aHandled = handled(base.transactions, a),
    bHandled = handled(base.transactions, b);
  requireThat(aHandled && bHandled, "C06_HANDLED_BOUNDARY");
  const deadline = Date.parse(bHandled.occurred_at) + capMs;
  let prefix = 0;
  for (const text of fillerTexts(fixturePrefix)) {
    if (Date.now() >= deadline) break;
    await fixtureMessage(run, text, deadline);
    prefix++;
  }
  const source = stableID("main.input.message:" + b);
  while (
    Date.now() < deadline &&
    !observe().compactions.some(
      (j: any) =>
        j.mode === "WORKING_MEMORY" &&
        j.state === "COMMITTED" &&
        j.source_end_sequence >= bHandled.sequence &&
        j.source_event_ids.includes(source),
    )
  ) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const state = snapshot(core);
  const boundary = correctionBoundary(
    state.transactions,
    session,
    b,
    bHandled.sequence,
    deadline,
  );
  const inputs = {
    a,
    b,
    a_handled: aHandled.event_id,
    b_handled: bHandled.event_id,
    deadline,
    fixture_prefix: fixturePrefix,
    prefix_handled: prefix,
  };
  if (!boundary || Date.now() >= deadline || prefix !== fixturePrefix.count) {
    const status = maintenanceBoundary(
      observe().compactions.filter((j: any) => j.mode === "WORKING_MEMORY"),
      source,
      bHandled.sequence,
      {
        at_cap: true,
        session_state: observe().sessions[0].state,
        settings_blocked: false,
      },
    ).status;
    return {
      inputs,
      boundary,
      status,
      use: "NOT_TESTED",
      physical_provider_sends: 0,
    };
  }
  const probe = await fixtureMessage(run, coldCase.probe, deadline);
  const final = snapshot(core),
    loop = observe().input_records.find((i: any) => i.id === probe)?.loop_id;
  const sends = correctionSends(
    final.transactions,
    boundary.index,
    boundary.revision,
    session,
    probe,
    loop,
  );
  const references = sends.chain.map((c) => ({
    context: c.id,
    call: c.call_id,
    revision: c.consciousness_revision,
  }));
  const first = sends.first;
  const call =
    first &&
    final.records.find(
      (r) =>
        r.record_type === "ModelCall" &&
        r.id === first.call_id &&
        r.context_id === first.id &&
        r.started_at,
    );
  if (!call)
    return {
      inputs,
      boundary,
      probe,
      references,
      status: "FIRST_SEND_MISSING",
      use: "UNRESOLVED",
      physical_provider_sends: 0,
    };
  const visibility: Record<string, ReturnType<typeof wireVisibility>> = {};
  const samples = await captureBodies(
    cas(core, call.request),
    (model, bytes) => {
      const payload = JSON.parse(bytes.toString());
      visibility[model] = wireVisibility(payload);
      writeJSON(path.join(run.evidence, "c06-" + model + "-body.json"), {
        encoded: bytes.toString("base64"),
        sha256: sha(bytes),
        call: call.id,
      });
    },
  );
  const events = final.transactions.flatMap((f) => f.events);
  const calls = sends.chain.flatMap((ctx) => {
    const record = final.records.find(
      (r) =>
        r.record_type === "ModelCall" &&
        r.id === ctx.call_id &&
        r.context_id === ctx.id &&
        r.started_at,
    );
    const event = events.find(
      (e) =>
        e.event_type === "model.context" &&
        e.scope.session_id === session &&
        cas(core, e.payload).id === ctx.id,
    );
    return record?.record_type === "ModelCall" && event
      ? [
          {
            id: record.id,
            loop: ctx.loop_id,
            sequence: event.sequence,
            request: cas(core, record.request),
            response: record.response ? cas(core, record.response) : null,
          },
        ]
      : [];
  });
  const reads = sourceReads(session, b, coldCase.setup[1], events, calls, (r) =>
    cas(core, r),
  );
  const semantic = judgeCorrection({
    maintenance: "UNKNOWN",
    visibility: "UNKNOWN",
    resident_old: null,
    source_delivered: reads.some((r) => r.delivered_to !== null),
    supported_use: null,
    reached: true,
  });
  const result = {
    inputs,
    boundary,
    probe,
    reads,
    semantic,
    status: "CAPTURED",
    probe_revision: first.consciousness_revision,
    transition_call: sends.transition?.call_id,
    references,
    call: call.id,
    request_sha256: call.request.sha256,
    samples,
    visibility,
    evidence_class: "OFFLINE_SERIALIZER_CAPTURE",
    physical_provider_sends: 0,
    maintenance_semantics: "UNRESOLVED",
    natural_use: "UNRESOLVED",
    reader_status: "AWAITING_LIVE_GRADING_DECISION",
  };
  writeJSON(path.join(run.evidence, "stage-c-correction-receipt.json"), result);
  return result;
}
