import assert from "node:assert/strict";
import test from "node:test";
import { sha } from "../../online/benchmark/io.ts";
import { targetedC16Capture } from "../../online/benchmark/stage-c-targeted-capture.ts";
import { stableID } from "../../../sut/secretary/src/pi_secretary/src/execution-utils.ts";

function fixture() {
  const scope = { session_id: "session" },
    messages = [
      { role: "system", content: "system-private" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning-private" },
          { type: "text", text: "visible reply" },
        ],
      },
    ];
  const object = (value: any) => ({
    sha256: sha(JSON.stringify(value)),
    value,
  });
  const read = (ref: any) => ref.value;
  const memory = (job: string, revision: number) => ({
    record_type: "Consciousness",
    session_id: "session",
    last_job_id: job,
    covered_event_sequence: revision,
    revision,
    items: [
      { item_id: "item", summary: "current", source_refs: [object(messages)] },
    ],
  });
  const frame = (records: any[] = [], events: any[] = []) => ({
    records,
    events,
  });
  const commits = ["a", "b"].map((id, i) =>
    frame([
      {
        id,
        record_type: "CompactionJob",
        state: "COMMITTED",
        mode: "WORKING_MEMORY",
        session_id: "session",
      },
      memory(id, i + 1),
    ]),
  );
  const samples = commits.map((f) => {
    const m = f.records[1];
    return {
      job: m.last_job_id,
      revision: m.revision,
      covered: m.covered_event_sequence,
      items_sha256: sha(JSON.stringify(m.items)),
    };
  });
  const batch = {
    batch_id: "batch",
    changes: [
      {
        intent: "ASSERT",
        predicate: "p",
        value: "old",
        source_event_ids: ["input-event"],
      },
    ],
  };
  const params = object(batch);
  const op = {
    record_type: "Operation",
    id: "op",
    scope,
    action: {
      action: "world.change",
      parameters_hash: params.sha256,
      parameters_ref: params,
      intent_id: "batch",
      resource: "world/batch/batch",
    },
    state: "WAIT_AUTH",
    effect: "NOT_STARTED",
  };
  const input = {
    record_type: "Input",
    session_id: "session",
    producer: "MASTER",
    payload: { ...object("corrected input"), media_type: "text/plain" },
  };
  const context = {
    id: "context",
    call_id: "call",
    capture_kind: "MODEL_REQUEST",
    purpose: "MAIN",
    input_ids: ["probe"],
  };
  const ev = (event_id: string, event_type: string, value: any) => ({
    event_id,
    event_type,
    scope,
    payload: object(value),
  });
  const call = {
    record_type: "ModelCall",
    id: "call",
    state: "PREPARED",
    scope,
    context_id: "context",
    request: { sha256: "context-wire" },
  };
  const sends = [
    {
      id: "send",
      at: "time",
      attribution: { role: "main", context_sha256: "context-wire" },
      payload: { model: "fixture" },
    },
  ];
  const change = stableID("batch:change:0"),
    fid = stableID(change + ":assertion");
  const receipt = { status: "COMMITTED", batch_id: "batch", result_ids: [fid] };
  const applied = {
    ...op,
    state: "SUCCEEDED",
    effect: "APPLIED",
    receipt: object(receipt),
  };
  const fact = {
    id: fid,
    record_type: "WorldAssertion",
    change_id: change,
    status: "LIVE",
    replaces_id: null,
    predicate_key: "p",
    evidence_event_ids: ["input-event"],
    value: "old",
  };
  const effect = frame(
    [applied, fact],
    [
      ev("changed", "world.changed", receipt),
      ev("applied", "operation.journal_applied", applied),
    ],
  );
  const frames = [
    frame([op], [ev("input-event", "input.accepted", input)]),
    ...commits,
    frame([], [ev("request", "model.context", context)]),
    frame([call]),
    effect,
  ];
  const proof = {
    journal_digest: "d",
    maintenance: { samples },
    outcome: {
      probe_call: "call",
      probe_input: "probe",
      probe_send: "send",
      probe_payload: sha(JSON.stringify(sends[0].payload)),
    },
  };
  return {
    frames,
    effect,
    proof,
    sends,
    capture: () =>
      targetedC16Capture(
        { digest: "d", transactions: frames } as any,
        proof,
        sends,
        read,
      ),
  };
}
test("capture binds both committed samples, the first wire and the temporal proposal boundary", () => {
  const f = fixture(),
    result = f.capture();
  assert.deepEqual(
    result.snapshots.map((s) => s.sequence),
    [2, 3, 4],
  );
  assert.equal(result.proposals[0].state, "WAIT_AUTH");
  assert.equal(result.proposals[0].sources[0].text, "corrected input");
  assert.equal(result.proposals[0].committed, false);
  assert.equal(result.proposal_capture, "complete");
  assert.doesNotMatch(
    JSON.stringify(result),
    /system-private|reasoning-private/,
  );
  assert.match(JSON.stringify(result), /visible reply/);
  f.sends[0].payload.model = "different";
  assert.throws(f.capture, /C16_CAPTURE_PROBE_BINDING/);
});
test("only a matching fact revision and receipt before the request establish an executed change", () => {
  const f = fixture();
  f.frames.splice(3, 0, f.frames.pop()!);
  assert.equal(f.capture().proposals[0].committed, true);
  f.effect.records[1].value = "wrong";
  assert.equal(f.capture().proposal_capture, "missing");
  f.effect.records[1].value = "old";
  f.effect.events.pop();
  assert.equal(f.capture().proposals[0].receipt_matches, false);
});
test("a missing or reordered commit cannot supply a snapshot", () => {
  const f = fixture();
  f.proof.maintenance.samples.reverse();
  assert.throws(f.capture, /C16_CAPTURE_COMMIT_GAPS/);
  f.proof.maintenance.samples.reverse();
  f.proof.maintenance.samples[0].items_sha256 = "invalid";
  assert.throws(f.capture, /C16_CAPTURE_COMMIT_BINDING/);
});

test("a change in the request transaction preserves the earlier pending proposal", () => {
  const f = fixture();
  f.frames.pop();
  f.frames[3].records.push(...f.effect.records);
  f.frames[3].events.push(...f.effect.events);
  const result = f.capture();
  assert.equal(result.proposal_capture, "complete");
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].state, "WAIT_AUTH");
  assert.equal(result.proposals[0].committed, false);
});
