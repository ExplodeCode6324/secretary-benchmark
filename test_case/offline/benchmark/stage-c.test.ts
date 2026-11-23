import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tools as mainTools } from "../../../sut/secretary/src/pi_secretary/src/main-tools.ts";
import {
  checkedWorld,
  exactWorld,
} from "../../online/benchmark/stage-b-scenarios-protocol.ts";
import { inspectStageEvidence } from "../../online/benchmark/stage-b-scenarios-evidence.ts";
import { hostEvidence } from "../../online/benchmark/stage-b-report-evidence.ts";
import { stableID } from "../../../sut/secretary/src/pi_secretary/src/execution-utils.ts";
import { sha, repository, readJSON } from "../../online/benchmark/io.ts";
import {
  correctionBoundary,
  correctionSends,
  correctionControls,
  checkReader,
} from "../../online/benchmark/stage-c-correction.ts";
import {
  sourceReads,
  judgeCorrection,
} from "../../online/benchmark/stage-c-reader.ts";
import {
  countRecoveryWrites,
  requireLostAck,
} from "../../online/benchmark/stage-c-recovery.ts";
import { prospectiveMatrix } from "../../online/benchmark/stage-c.ts";

test("C05-W pins all product change properties and permits the sole annotation only within full approval binding", () => {
  const schema: any = mainTools
    .call(
      { store: { projectionFrames: [] }, scheduler: { scopes: {} } } as any,
      "loop",
      [],
    )
    .find((t) => t.name === "memory_propose_change")!.parameters;
  const item = schema.properties.changes.items;
  const fields =
    "intent local_ref subject entity_kind display_name rename aliases predicate topic value keywords target_fact_id source_event_ids valid_from valid_to fresh_until source_note".split(
      " ",
    );
  assert.deepEqual(Object.keys(item.properties).sort(), fields.sort());
  assert.deepEqual(item.required, ["intent"]);
  assert.equal(item.additionalProperties, false);
  assert.equal(item.properties.source_note.maxLength, 2000);
  assert.equal(item.properties.source_note.type, "string");
  const source = randomUUID(),
    batch_id = randomUUID();
  const changes = [
    {
      intent: "CREATE_ENTITY",
      local_ref: "$fern",
      entity_kind: "PROJECT",
      display_name: "Fern",
      source_event_ids: [source],
    },
    {
      intent: "ASSERT",
      subject: "$fern",
      predicate: "entity.note",
      topic: "current_context",
      value: "Fern pickup is Thursday.",
      keywords: [],
      source_event_ids: [source],
    },
  ];
  const b = (extra: object) => ({
    version: 1,
    batch_id,
    changes: changes.map((c) => ({ ...c, ...extra })),
  });
  for (const extra of [
    {},
    { source_note: "" },
    { source_note: "🌿".repeat(2000) },
  ])
    assert(exactWorld(b(extra), source, false));
  for (const extra of [
    { source_note: 8 },
    { source_note: null },
    { source_note: "🌿".repeat(2001) },
    { valid_to: null },
    { unknown: "x" },
    { source_event_ids: [] },
    { subject: "$other" },
  ])
    assert(!exactWorld(b(extra), source, false));
  const batch = b({ source_note: "annotation" }),
    scope = { session_id: "s", execution_id: null };
  const param = { sha256: sha(JSON.stringify(batch)) };
  const action = {
    action: "world.change",
    parameters_ref: param,
    parameters_hash: param.sha256,
    intent_id: batch_id,
    resource: "world/batch/" + batch_id,
  };
  const preview = {
    scope,
    action,
    parameters: b({ source_note: "different" }),
  };
  const display = { sha256: sha(JSON.stringify(preview)) };
  const auth = {
    id: "a",
    operation_id: "op",
    state: "PENDING",
    scope,
    action,
    display_ref: display,
    display_hash: display.sha256,
  };
  assert.throws(
    () =>
      checkedWorld(
        { object: (r: any) => (r === param ? batch : preview) } as any,
        {
          session_id: "s",
          authorizations: [auth],
          operations: [
            {
              id: "op",
              scope,
              action,
              state: "WAIT_AUTH",
              authorization_id: "a",
            },
          ],
        } as any,
        source,
        false,
      ),
    /WORLD_BATCH/,
  );
});

test("C10 settlement and authorization diagnostics require the original task, execution and pending operation", () => {
  const bound = {
    execution: "e",
    task: "t",
    condition: "c",
    release_at: "now",
  };
  const exec = {
    record_type: "Execution",
    id: "e",
    task_id: "t",
    state: "WAIT_AUTH",
    waiting_request_ids: ["a"],
    condition_results: [{ condition_id: "c", status: "MET" }],
  };
  const scope = { execution_id: "e", task_id: "t" },
    action = { action: "shell.run" };
  const auth = {
    record_type: "AuthorizationRequest",
    id: "a",
    operation_id: "o",
    scope,
    state: "PENDING",
    action,
  };
  const op = {
    record_type: "Operation",
    id: "o",
    authorization_id: "a",
    scope,
    state: "WAIT_AUTH",
    action,
  };
  const audit = (e: any, b: any, extra: any[]) => {
    const proof = inspectStageEvidence(
      "C10-condition",
      { inputs: [], decisions: [], cycles: [], task: b },
      [{ events: [], records: [e, op, ...extra] }],
      () => ({}),
      [],
      [],
      "main",
    );
    return {
      requirements: proof.requirements,
      task: hostEvidence({ proof, failures: proof.requirements }).task,
    };
  };
  const result = audit(exec, bound, [auth]);
  assert.deepEqual(result.requirements, ["TASK_TERMINAL_MISSING"]);
  assert.equal(result.task?.wait_reason, "PENDING_AUTHORIZATION");
  assert.equal(result.task?.effects, "UNRESOLVED");
  assert.equal(
    audit(exec, bound, [{ ...auth, operation_id: "wrong" }]).task?.wait_reason,
    null,
  );
  assert.equal(
    audit(
      {
        ...exec,
        condition_results: [{ condition_id: "c", status: "NOT_MET" }],
      },
      bound,
      [],
    ).task?.activation,
    "NOT_MET",
  );
  assert.equal(
    audit(exec, { ...bound, execution: "unknown" }, []).task?.activation,
    "UNKNOWN",
  );
  const u = {
    ...op,
    id: "u",
    effect: "UNKNOWN",
    action: { action: "file.write" },
  };
  assert.equal(audit(exec, bound, [u]).task?.unknown_writes, 1);
  const old = hostEvidence({
    schema: "issue122-stage-scenario-evidence-v1",
    proof: { task: { condition_met_or_answered: true } },
    failures: [],
  });
  assert(!Object.hasOwn(old.task!, "activation"));
});
test("C06 first covering ordinary revision, first probe and independent corrected-day controls", () => {
  const session = "main",
    input = "b",
    event = stableID("main.input.message:" + input);
  const job = {
    id: "j",
    record_type: "CompactionJob",
    session_id: session,
    mode: "WORKING_MEMORY",
    source_end_sequence: 11,
    source_event_ids: [event],
    state: "COMMITTED",
  };
  const memory = {
    record_type: "Consciousness",
    last_job_id: "j",
    revision: 4,
    covered_event_sequence: 11,
    session_id: session,
    items: [],
  };
  const c = {
    record_type: "Context",
    session_id: session,
    revision: 1,
    loop_id: "p",
    input_ids: ["i"],
    capture_kind: "MODEL_REQUEST",
    purpose: "MAIN",
    consciousness_revision: 4,
  };
  const records = [
    [{ ...job, mode: "CONTEXT_COMPACTION" }],
    [job, memory],
    [{ ...c, loop_id: "filler" }],
    [c],
    [{ ...c, consciousness_revision: 7 }],
  ];
  const frames = records.map((records) => ({ records, events: [] }));
  assert.equal(correctionBoundary(frames, session, input, 10)?.index, 1);
  assert.equal(
    correctionSends(frames, 1, 4, session, "i", "p").transition.loop_id,
    "filler",
  );
  assert.equal(
    correctionSends(frames, 1, 4, session, "i", "p").first
      .consciousness_revision,
    4,
  );
  assert.equal(correctionSends(frames, 1, 5, session, "i", "p").first, null);
  const controls = correctionControls();
  assert(!JSON.stringify(controls.reader).includes('"expected":'));
  const answers = controls.key.map((k) => ({
    id: k.id,
    visibility: k.expected,
  }));
  checkReader(controls.key, answers);
  assert.throws(
    () => checkReader(controls.key, answers.slice(1)),
    /CALIBRATION/,
  );
  const v = {
    maintenance: "STALE_CURRENT",
    visibility: "COLD",
    resident_old: true,
    source_delivered: true,
    supported_use: true,
    reached: true,
  } as const;
  assert.deepEqual(judgeCorrection(v), {
    maintenance: "FAIL",
    use: "PASS",
    stale_resident_and_cold: true,
  });
  assert.equal(judgeCorrection({ ...v, source_delivered: false }).use, "FAIL");
  assert.equal(
    judgeCorrection({ ...v, visibility: "RESIDENT", source_delivered: false })
      .use,
    "PASS",
  );
  assert.equal(
    judgeCorrection({ ...v, visibility: "UNKNOWN" }).use,
    "UNRESOLVED",
  );
  assert.equal(judgeCorrection({ ...v, reached: false }).use, "NOT_TESTED");
});
test("C12b rules reject an acknowledged write and count repeated identical physical writes", () => {
  const record = {
    operation: "op",
    resource: "p",
    execution: "e",
    run: "r",
    lineage: "l",
    domain: "d",
    request: "q",
    expected_hash: "hash",
    observed_hash: "hash",
    pid: 2,
  };
  assert.doesNotThrow(() =>
    requireLostAck([{ state: "DISPATCHED", receipt: null }]),
  );
  assert.throws(
    () =>
      requireLostAck([
        { state: "DISPATCHED" },
        { state: "SUCCEEDED", receipt: {} },
      ]),
    /OLD_RESULT/,
  );
  assert.equal(countRecoveryWrites([record], [record], record, false), "PASS");
  assert.equal(
    countRecoveryWrites([record], [record, record], record, false),
    "FAIL",
  );
  assert.equal(
    countRecoveryWrites(
      [record],
      [{ ...record, domain: "other" }],
      record,
      false,
    ),
    "FAIL",
  );
  assert.equal(
    countRecoveryWrites(
      [record],
      [{ ...record, operation: "other" }],
      record,
      false,
    ),
    "UNRESOLVED",
  );
  assert.equal(countRecoveryWrites([record], [], record, false), "UNRESOLVED");
  assert.equal(
    countRecoveryWrites([record], [record], record, true),
    "UNRESOLVED",
  );
});
test("preparation refuses all live or old approvals and keeps all controls and exclusions", () => {
  const matrix = prospectiveMatrix();
  assert.equal(matrix.candidate_observations, 288);
  assert.equal(matrix.source_lineages, 270);
  assert(matrix.rows.every((r) => !r.eligible_to_dispatch));
  assert(
    matrix.rows
      .filter((r) => r.scenario === "C16-combined")
      .every((r) => r.disposition === "DEFERRED_BY_DECISION"),
  );
  for (const command of [
    "baseline-stage-c-start",
    "baseline-stage-c-prepare",
  ]) {
    const root = path.join(repository, ".local/benchmark/tests", randomUUID());
    const r = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "test_case/online/benchmark/cli.ts",
        command,
        "--root",
        root,
        "--approval",
        "stage-b-old",
      ],
      { encoding: "utf8", cwd: repository },
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /STAGE_C_OFFLINE_ONLY/);
    assert(!fs.existsSync(root));
  }
});

test("source retrieval binds accepted event, exact tool result and later call in the original loop", () => {
  const input = "b",
    text = "Changed to Saturday",
    args = { source: "log", event_id: "accepted" },
    session = "s";
  const ref = (v: object) => ({ value: v, sha256: sha(JSON.stringify(v)) });
  const record = {
    schema: "record",
    id: input,
    producer: "MASTER",
    payload: { sha256: sha(text) },
  };
  const content = [
    {
      type: "text",
      text: JSON.stringify({
        event_id: "accepted",
        body_hash: sha(text),
        body: text,
      }),
    },
  ];
  const events = [
    {
      event_type: "input.accepted",
      event_id: "accepted",
      scope: { session_id: session },
      sequence: 1,
      payload: ref(record),
    },
    {
      event_type: "main.tool.result",
      event_id: "result",
      scope: { session_id: session },
      sequence: 4,
      payload: ref({
        key: "loop:2:id:memory_read:" + sha(JSON.stringify(args)),
        result: { content },
      }),
    },
  ];
  const calls = [
    {
      id: "read",
      loop: "loop",
      sequence: 3,
      request: { messages: [] },
      response: {
        content: [
          { type: "toolCall", name: "memory_read", id: "id", arguments: args },
        ],
      },
    },
    {
      id: "use",
      loop: "loop",
      sequence: 5,
      request: {
        messages: [
          {
            role: "toolResult",
            toolCallId: "id",
            toolName: "memory_read",
            content,
          },
        ],
      },
      response: { content: [{ type: "text", text: "Saturday" }] },
    },
  ];
  const run = (c = calls) =>
    sourceReads(session, input, text, events, c, (r) => r.value);
  assert.equal(run()[0].delivered_to, "use");
  assert.equal(
    run([{ ...calls[0] }, { ...calls[1], loop: "other" }])[0].delivered_to,
    null,
  );
  assert.deepEqual(
    sourceReads(session, "wrong", text, events, calls, (r) => r.value),
    [],
  );
});

test(
  "Stage C CLI exports five isolated no-provider fixtures with independently witnessed direct recovery",
  { timeout: 230000 },
  () => {
    const root = path.join(repository, ".local/benchmark/tests", randomUUID());
    const invoke = (command: string) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "test_case/online/benchmark/cli.ts",
          command,
          "--root",
          root,
        ],
        { cwd: repository, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      );
    const prepared = invoke("baseline-stage-c-prepare");
    assert.equal(prepared.status, 0, prepared.stderr);
    const exported = invoke("baseline-stage-c-report");
    assert.equal(exported.status, 0, exported.stderr);
    const report = JSON.parse(exported.stdout);
    assert.equal(report.physical_provider_sends, 0);
    assert.equal(report.memory_performance, "NOT_TESTED");
    const r = report.recovery.observations;
    assert.deepEqual(
      [r.effects, r.physical_writes, r.kind, r.host_assisted],
      ["PASS", 1, "DIRECT_SAME_DOMAIN", true],
    );
    assert.notEqual(r.old_exit, r.new_start);
    assert.notEqual(r.pre_restart_journal, r.unknown_journal);
    const c = report.correction.observations;
    assert.equal(c.status, "CAPTURED");
    assert(c.probe_revision >= c.boundary.revision);
    assert(c.transition_call);
    assert.equal(c.samples.length, 3);
    assert.equal(c.natural_use, "UNRESOLVED");
    const ids = [
      report.recovery.run,
      report.correction.run,
      ...report.controls.map((v: any) => v.run),
    ];
    assert.equal(new Set(ids).size, 5);
    for (const id of ids) {
      assert.equal(
        readJSON(path.join(root, "runs", id + ".json")).state,
        "STOPPED",
      );
      assert(fs.existsSync(path.join(root, "evidence", id, "seal.json")));
    }
    assert.match(
      invoke("baseline-stage-c-prepare").stderr,
      /FRESH_FACILITY_REQUIRED/,
    );
  },
);
