import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { App } from "../../../sut/secretary/src/pi_secretary/src/app.ts";
import { ApplicationService } from "../../../sut/secretary/src/pi_secretary/src/application-service.ts";
import {
  fixtureModel,
  fixtureStream,
  replyStream,
  type StreamFn,
} from "../../../sut/secretary/src/pi_secretary/src/model.ts";
import type {
  Operation,
  Session,
} from "../../../sut/secretary/src/pi_secretary/src/contracts.ts";
import { stableID } from "../../../sut/secretary/src/pi_secretary/src/execution-utils.ts";
import { baselineCases } from "../../online/benchmark/baseline-scenarios.ts";
import { timeline } from "../../online/benchmark/baseline-timeline.ts";
import { completedFileWrite } from "../../online/benchmark/effect-proof.ts";
import {
  cas,
  inspectStageEvidence,
  wireVisibility,
} from "../../online/benchmark/stage-b-scenarios-evidence.ts";
import {
  checkAbort,
  checkedWorld,
  emptyTrail,
  exactWorld,
  playStageScenario,
  validateScenario,
  type ScenarioHost,
  type ScenarioObservation,
} from "../../online/benchmark/stage-b-scenarios-protocol.ts";
import { placeStageFile } from "../../online/benchmark/stage-b-scenarios.ts";
import { read, sha } from "../../online/benchmark/io.ts";
import { snapshot } from "../../online/benchmark/snapshot.ts";

const steps = (id: string) =>
  timeline(baselineCases(true).find((c) => c.id === id)!);
test("C10 pilot and expanded routes retain distinct executable inputs", () => {
  assert.equal(
    baselineCases(true).find((c) => c.id === "C10-model-created-resource")
      ?.status,
    "UNSUPPORTED",
  );
  const model = steps("C10-model-created");
  assert(model.some((s) => s.action === "MASTER_ANSWER"));
  assert(
    !model.some((s) => ["MASTER_TASK", "SCRIPTED_FILE"].includes(s.action)),
  );
  assert.throws(() => validateScenario("C10-condition", model), /TIMELINE/);
  assert.throws(() => validateScenario("C05-W", []), /TIMELINE/);
  assert(!steps("C10-condition").some((s) => s.action === "MASTER_ANSWER"));
});

const batch = (source: string, corrected: boolean) => ({
  version: 1,
  batch_id: randomUUID(),
  changes: [
    {
      intent: "CREATE_ENTITY",
      entity_kind: "PROJECT",
      local_ref: "$fern",
      display_name: "Fern",
      source_event_ids: [source],
    },
    {
      intent: "ASSERT",
      subject: "$fern",
      predicate: "entity.note",
      topic: "current_context",
      value: corrected
        ? "Fern pickup is Saturday. Only redacted copies may be collected."
        : "Fern pickup is Thursday.",
      keywords: [],
      source_event_ids: [source],
    },
  ],
});
test("C05 requires exact source, action, display and operation before a decision", () => {
  const source = randomUUID(),
    b = batch(source, true),
    scope = { session_id: "session", execution_id: null };
  const ref = { sha256: sha(JSON.stringify(b)) };
  const action = {
    action: "world.change",
    parameters_ref: ref,
    parameters_hash: ref.sha256,
    intent_id: b.batch_id,
    resource: "world/batch/" + b.batch_id,
  };
  const preview = { scope, action, parameters: b };
  const a = {
    id: "a",
    operation_id: "op",
    action,
    scope,
    state: "PENDING",
    display_ref: { sha256: sha(JSON.stringify(preview)) },
    display_hash: sha(JSON.stringify(preview)),
  };
  const o = {
    session_id: "session",
    authorizations: [a],
    operations: [
      { state: "WAIT_AUTH", authorization_id: "a", id: "op", scope, action },
    ],
  } as unknown as ScenarioObservation;
  const host = {
    object: (r: any) => (r === ref ? b : preview),
  } as ScenarioHost;
  assert.equal(checkedWorld(host, o, source, true)?.a.id, "a");
  assert.throws(() => checkedWorld(host, o, "historical", true), /WORLD_BATCH/);
  assert(!exactWorld(b, source, false));
  assert(
    !exactWorld({ ...b, changes: [...b.changes, b.changes[1]] }, source, true),
  );
  a.display_hash = sha("another");
  assert.throws(() => checkedWorld(host, o, source, true), /WORLD_BINDING/);
});

for (const id of ["C10-condition", "C10-answer", "C10-model-created"])
  test(
    id +
      " runs through in-process Secretary admission, waiting execution and one completed write",
    async () => {
      const core = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "stage-scenario-"),
      );
      const calls: string[] = [],
        sends: any[] = [],
        writes: any[] = [];
      let turns = 0,
        proposed = false;
      const tool = (name: string, args: Record<string, string | string[]>) =>
        replyStream([
          { type: "toolCall", id: randomUUID(), name, arguments: args },
        ]);
      const main: StreamFn = (m, c, o) => {
        sends.push({
          id: randomUUID(),
          at: new Date().toISOString(),
          payload: { messages: c.messages },
          attribution: { role: "main", context_sha256: sha(JSON.stringify(c)) },
        });
        if (id === "C10-model-created" && !proposed) {
          proposed = true;
          return tool("task_propose", {
            title_candidate: "Checklist",
            goal: "Ask for the format before writing result.txt",
            acceptance_criteria: ["One result.txt"],
          });
        }
        return replyStream([
          { type: "text", text: "Checklist status acknowledged." },
        ]);
      };
      const task: StreamFn = (m, c, o) => {
        const turn = turns++;
        if (turn === 0)
          return id === "C10-condition"
            ? tool("read", { path: "ready.txt" })
            : tool("request_decision", {
                question: "Which format should I use?",
              });
        if (turn === 1)
          return tool("write", { path: "result.txt", content: "Three items." });
        return fixtureStream(m, c, o);
      };
      const app = await App.open(
        core,
        {
          main: { model: fixtureModel, stream: main },
          task: { model: fixtureModel, stream: task },
        },
        undefined,
        { pushDelivery: async () => {} },
      );
      try {
        const api = new ApplicationService(app),
          owner = {
            kind: "local-owner" as const,
            owner_id: api.identity.owner_id,
          };
        const finish = app.authorization.finish.bind(app.authorization);
        app.authorization.finish = (opID, value, outcome) => {
          const op = app.store.get<Operation>("Operation", opID);
          const proof = value as any;
          if (
            completedFileWrite(
              op,
              value,
              outcome,
              () => read(op.action.resource),
              () => app.store.bytes(proof.evidence),
            )
          )
            writes.push({
              operation_id: opID,
              execution_id: op.scope.execution_id,
              resource: op.action.resource,
              content_sha256: proof.evidence.sha256,
              at: new Date().toISOString(),
            });
          return finish(opID, value, outcome);
        };
        const trail = emptyTrail();
        const host: ScenarioHost = {
          now: Date.now,
          sleep: async () => {
            await app.settle();
          },
          guard: () => {},
          record: () => {},
          observe: () => ({
            sequence: app.store.sequence,
            session_id: app.host.sessionID,
            last_handled_sequence: 0,
            input_records: app.store.all("Input"),
            input_events: app.store.events("input.accepted").map((e) => ({
              event_id: e.event_id,
              input_id: app.store.read<any>(e.payload).id,
            })),
            authorizations: app.store.all("AuthorizationRequest"),
            operations: app.store.all("Operation"),
            tasks: app.store.all("TaskPlan"),
            executions: app.store.all("Execution"),
            calls: app.store.all("ModelCall"),
            sessions: app.store.all<Session>("Session"),
            compactions: app.store.all("CompactionJob"),
          }),
          command: async (route, body) => {
            calls.push(route);
            return api.command(owner, route, body);
          },
          question: async (id) =>
            (await api.query(
              owner,
              "decisions/" + id,
              new URLSearchParams(),
            )) as any,
          object: (r) => cas(core, r),
          modelProposed: (loop, plan) =>
            app.store.events("main.tool.result").some((e) => {
              const p = app.store.read<any>(e.payload);
              return (
                p.key.startsWith(loop + ":") &&
                p.key.includes(":task_propose:") &&
                stableID(p.key) === plan.proposal_request_id
              );
            }),
          writes: () => writes,
          place: (...args) => placeStageFile(core, ...args),
          restart: async () => assert.fail("unexpected restart"),
        };
        await playStageScenario(
          id,
          steps(id),
          host,
          trail,
          AbortSignal.timeout(12000),
        );
        assert.equal(trail.task?.model_created, id === "C10-model-created");
        assert.equal(
          calls.includes("task-requests"),
          id !== "C10-model-created",
        );
        assert.equal(
          calls.some((c) => c.startsWith("decisions/")),
          id !== "C10-condition",
        );
        assert.equal(trail.task?.terminal, "SUCCEEDED");
        const state = snapshot(core);
        const proof = inspectStageEvidence(
          id,
          trail,
          state.transactions,
          (r) => cas(core, r),
          sends,
          writes,
          app.host.sessionID,
        );
        assert.deepEqual(proof.requirements, []);
        assert.equal(proof.task?.effects, "PASS");
        assert.equal(proof.task?.matching_writes, 1);
        assert.equal(
          inspectStageEvidence(
            id,
            trail,
            state.transactions,
            (r) => cas(core, r),
            sends,
            [],
            app.host.sessionID,
          ).task?.effects,
          "UNRESOLVED",
        );
        assert.equal(
          inspectStageEvidence(
            id,
            trail,
            state.transactions,
            (r) => cas(core, r),
            sends,
            [...writes, ...writes],
            app.host.sessionID,
          ).task?.effects,
          "FAIL",
        );
      } finally {
        await app.close();
        fs.rmSync(core, { recursive: true, force: true });
      }
    },
  );

function journalFixture() {
  const session = "main",
    frames: { records: any[]; events: any[] }[] = [],
    sends: any[] = [];
  const blobs = new Map<string, any>();
  const save = (v: any) => {
    const data = JSON.stringify(v),
      hash = sha(data);
    blobs.set(hash, v);
    return {
      path: "objects/" + hash,
      bytes: Buffer.byteLength(data),
      sha256: hash,
    };
  };
  const object = (r: { sha256: string }) => blobs.get(r.sha256);
  let seq = 0;
  const event = (kind: string, v: any) => ({
    scope: { session_id: session },
    event_type: kind,
    event_id: randomUUID(),
    sequence: ++seq,
    payload: save(v),
  });
  function freeze(loop: string) {
    frames.push({
      records: [{ id: loop, record_type: "MainPromptSnapshot", revision: 1 }],
      events: [],
    });
  }
  function call(
    loop: string,
    input: string,
    messages: any[],
    reply: any,
    wire: any = { messages },
    purpose = "MAIN",
  ) {
    const id = randomUUID(),
      context = randomUUID(),
      request = save({ messages }),
      at = new Date(1000 + seq).toISOString();
    const c = {
      id: context,
      record_type: "Context",
      call_id: id,
      loop_id: loop,
      input_ids: [input],
      purpose,
      capture_kind: "MODEL_REQUEST",
    };
    frames.push({
      records: [
        c,
        {
          id,
          record_type: "ModelCall",
          context_id: context,
          started_at: at,
          completed_at: at,
          request,
          response: save(reply),
        },
      ],
      events: [event("model.context", c)],
    });
    const send = {
      id: randomUUID(),
      at,
      payload: wire,
      attribution: { role: "main", context_sha256: request.sha256 },
    };
    sends.push(send);
    return { id, send };
  }
  return { session, frames, sends, save, object, event, freeze, call };
}
test("C05 first eligible captured Main request uses a snapshot frozen after the exact commit", () => {
  const f = journalFixture(),
    trail = emptyTrail();
  trail.inputs.push({
    id: "i",
    request: "r",
    loop: "probe",
    probe: true,
    text_sha256: sha("query"),
  });
  trail.decisions = [
    {
      operation: "bad",
      authorization: "denied",
      source: "i1",
      decision: "REJECT",
      parameters_sha256: sha("a"),
      display_sha256: sha("p"),
    },
    {
      operation: "good",
      authorization: "approved",
      source: "i2",
      decision: "APPROVE",
      parameters_sha256: sha("b"),
      display_sha256: sha("q"),
    },
  ];
  trail.restart = { restart_observed: true } as any;
  f.freeze("stale");
  const receipt = { status: "COMMITTED", batch_id: "batch" };
  f.frames.push({
    records: [
      {
        record_type: "Operation",
        id: "good",
        state: "SUCCEEDED",
        effect: "APPLIED",
        action: { intent_id: "batch" },
        receipt: f.save(receipt),
      },
      { record_type: "AuthorizationRequest", id: "denied", state: "REJECTED" },
    ],
    events: [f.event("world.changed", receipt)],
  });
  const reply = { content: [{ type: "text", text: "Saturday." }] };
  f.call("stale", "i0", [], reply);
  f.freeze("other");
  f.call("other", "i3", [1], reply, {}, "COMPACTION");
  const first = f.call("other", "i3", [2], reply);
  f.freeze("probe");
  f.call("probe", "i", [3], reply);
  const audit = () =>
    inspectStageEvidence(
      "C05-W",
      trail,
      f.frames,
      f.object,
      f.sends,
      [],
      f.session,
    );
  assert.equal(audit().world?.first_eligible_call, first.id);
  assert.deepEqual(audit().requirements, []);
  first.send.attribution.context_sha256 = sha("unrelated");
  assert(audit().requirements.includes("WORLD_BOUNDARY_MISSING"));
});
test("C16 separates raw and echo exit and binds a successful original read and later use to one probe loop", () => {
  const f = journalFixture(),
    trail = emptyTrail();
  for (const [id, loop] of [
    ["original", "setup"],
    ["filler", "final"],
    ["probe", "question"],
  ])
    trail.inputs.push({
      id,
      request: id,
      loop,
      source_event: id + "-event",
      text_sha256: sha(id),
      probe: id === "probe",
    });
  trail.restart = { restart_observed: true } as any;
  for (let n = 1; n <= 2; n++) {
    const id = "job" + n;
    trail.cycles.push({ job: id, boundary: n, through: n, attempts: [id] });
    f.frames.push({
      events: [],
      records: [
        {
          record_type: "CompactionJob",
          session_id: "main",
          state: "COMMITTED",
          mode: "WORKING_MEMORY",
          id,
          source_end_sequence: n,
          source_event_ids: [],
          source_refs: [],
          candidate_ref: f.save({ items: [] }),
        },
        {
          record_type: "Consciousness",
          session_id: "main",
          last_job_id: id,
          covered_event_sequence: n,
          revision: n,
          items: [],
        },
      ],
    });
  }
  const text = (v: string) => ({ content: [{ type: "text", text: v }] });
  const q = [{ role: "user", content: "Find the Fern source" }];
  f.call(
    "final",
    "filler",
    [{ role: "user", content: "Moss shelf" }],
    text("Received."),
  );
  const args = { source: "log", event_id: "original-event" };
  const fetch = f.call("question", "probe", q, {
    content: [
      { type: "toolCall", name: "memory_read", id: "read-id", arguments: args },
    ],
  });
  f.frames.push({
    records: [],
    events: [
      {
        ...f.event("input.accepted", {
          id: "original",
          producer: "MASTER",
          payload: { sha256: sha("original") },
        }),
        event_id: "original-event",
      },
    ],
  });
  const result = text(
    JSON.stringify({
      event_id: "original-event",
      body: "LIME-427",
      body_hash: sha("original"),
    }),
  );
  f.frames.push({
    records: [],
    events: [
      f.event("main.tool.result", {
        key: "question:2:read-id:memory_read:" + sha(JSON.stringify(args)),
        result,
      }),
    ],
  });
  const use = f.call(
    "question",
    "probe",
    [
      ...q,
      {
        ...result,
        role: "toolResult",
        toolName: "memory_read",
        toolCallId: "read-id",
      },
    ],
    text("Locker LIME-427."),
  );
  const audit = () =>
    inspectStageEvidence(
      "C16-combined",
      trail,
      f.frames,
      f.object,
      f.sends,
      [],
      f.session,
    );
  assert.deepEqual(audit().requirements, []);
  assert.equal(audit().cold?.reads[0].request_call, fetch.id);
  assert.equal(audit().cold?.reads[0].use_call, use.id);
  assert.equal(audit().cold?.natural_access, "UNRESOLVED");
  trail.inputs[0].source_event = "other-event";
  assert.deepEqual(audit().cold?.reads, []);
  trail.inputs[0].source_event = "original-event";
  use.send.attribution.context_sha256 = sha("different");
  assert.equal(audit().cold?.reads[0].use_call, null);
  for (const wire of [
    {
      input: [{ role: "assistant", content: "LIME-427" }],
      previous_response_id: "opaque",
    },
    {
      messages: [{ role: "tool", content: "LIME-427" }],
      previous_response_id: "opaque",
    },
  ]) {
    const view = wireVisibility(wire);
    assert.equal(view.opaque, true);
    assert.deepEqual(view.literal_hits?.raw, []);
    assert.deepEqual(view.literal_hits?.echo, ["LIME-427"]);
  }
  f.frames[0].records[0].mode = "CONTEXT_COMPACTION";
  assert(audit().requirements.includes("TWO_MAINTENANCE_COMMITS_MISSING"));
});

function cycleHost(abortAtSleep?: AbortController) {
  let time = 0,
    count = 0,
    last = "",
    restarts = 0;
  const inputs: any[] = [],
    jobs: any[] = [],
    order: string[] = [];
  const o = {
    sequence: 0,
    input_records: inputs,
    input_events: [] as any[],
    sessions: [{ state: "IDLE" }],
    session_id: "main",
    calls: [],
    compactions: jobs,
    last_handled_sequence: 0,
  } as unknown as ScenarioObservation;
  const host: ScenarioHost = {
    now: () => time,
    sleep: async (ms, signal) => {
      time += ms;
      if (ms >= 60_000) {
        abortAtSleep?.abort();
        checkAbort(signal);
        jobs.push({
          id: randomUUID(),
          session_id: "main",
          state: "COMMITTED",
          mode: "WORKING_MEMORY",
          source_end_sequence: count,
          source_event_ids: [stableID("main.input.message:" + last)],
        });
        order.push("commit");
      }
    },
    observe: () => o,
    command: async (_route, body) => {
      count++;
      last = randomUUID();
      o.last_handled_sequence = count;
      inputs.push({
        id: last,
        state: "HANDLED",
        loop_id: randomUUID(),
        session_id: "main",
        producer: "MASTER",
        payload: { sha256: sha(String(body.text)) },
      });
      o.input_events.push({ input_id: last, event_id: randomUUID() });
      order.push("input");
      return {
        request_id: body.request_id,
        revision: "1",
        command: "messages",
        acceptance: "ACCEPTED",
        state: "COMPLETED",
        resource_ids: [{ type: "Input", id: last }],
        error_code: null,
      };
    },
    guard: () => {},
    record: () => {},
    restart: async () => {
      restarts++;
      order.push("restart");
      return { restart_observed: true } as any;
    },
    modelProposed: () => false,
    place: () => assert.fail(),
    question: async () => assert.fail(),
    object: () => assert.fail(),
    writes: () => [],
  };
  return { host, order, count: () => count, restarts: () => restarts };
}
test("C08 and C16 choreograph two distinct ordinary covered cycles before their frozen probes", async () => {
  for (const id of ["C08-inference", "C16-combined"]) {
    const h = cycleHost(),
      trail = emptyTrail(),
      frozen = steps(id);
    await playStageScenario(id, frozen, h.host, trail);
    assert.equal(trail.cycles.length, 2);
    assert(trail.cycles[1].boundary > trail.cycles[0].boundary);
    assert.equal(h.restarts(), id === "C16-combined" ? 1 : 0);
    assert.equal(trail.inputs.filter((i) => i.probe).length, 1);
    assert.equal(
      h.count(),
      frozen.reduce(
        (sum, s) =>
          sum + (s.filler?.count ?? Number(s.action === "MASTER_MESSAGE")),
        0,
      ),
    );
    assert.deepEqual(
      h.order.slice(id === "C16-combined" ? -3 : -2),
      id === "C16-combined"
        ? ["commit", "restart", "input"]
        : ["commit", "input"],
    );
  }
});
test("campaign abort during a maintenance wait suppresses later input, restart and effects", async () => {
  const c = new AbortController(),
    h = cycleHost(c),
    trail = emptyTrail();
  await assert.rejects(
    playStageScenario(
      "C16-combined",
      steps("C16-combined"),
      h.host,
      trail,
      c.signal,
    ),
    /SCENARIO_ABORTED/,
  );
  assert.equal(h.restarts(), 0);
  assert.equal(trail.inputs.filter((i) => i.probe).length, 0);
});

test("C05 choreography rejects A, approves corrected B, waits for its real receipt and restarts before the sole probe", async () => {
  const f = journalFixture(),
    order: string[] = [],
    t = emptyTrail();
  const o = {
    sequence: 0,
    session_id: "main",
    input_records: [],
    input_events: [],
    authorizations: [],
    operations: [],
    sessions: [{ state: "IDLE" }],
    calls: [],
  } as unknown as ScenarioObservation;
  const scope = { session_id: "main", task_id: null, execution_id: null };
  const host: ScenarioHost = {
    now: Date.now,
    sleep: async () => assert.fail("missing fixture observation"),
    observe: () => o,
    object: f.object,
    guard: () => {},
    record: () => {},
    writes: () => [],
    question: async () => assert.fail(),
    modelProposed: () => false,
    place: () => assert.fail(),
    restart: async () => {
      order.push("restart");
      return { restart_observed: true } as any;
    },
    command: async (route, body) => {
      let ids: { type: string; id: string }[] = [];
      if (route === "messages") {
        const id = randomUUID(),
          source = randomUUID();
        o.input_records.push({
          id,
          state: "HANDLED",
          loop_id: randomUUID(),
          session_id: "main",
          producer: "MASTER",
          payload: { sha256: sha(String(body.text)) },
        } as any);
        o.input_events.push({ input_id: id, event_id: source });
        ids = [{ type: "Input", id }];
        if (o.operations.length < 2) {
          const corrected = o.operations.length === 1;
          const b = batch(source, corrected),
            ref = f.save(b),
            auth = randomUUID(),
            op = randomUUID();
          const action = {
            action: "world.change",
            parameters_ref: ref,
            parameters_hash: ref.sha256,
            intent_id: b.batch_id,
            resource: "world/batch/" + b.batch_id,
          };
          const display = f.save({ scope, action, parameters: b });
          o.operations.push({
            id: op,
            authorization_id: auth,
            scope,
            action,
            state: "WAIT_AUTH",
          } as any);
          o.authorizations.push({
            id: auth,
            operation_id: op,
            revision: 1,
            scope,
            action,
            state: "PENDING",
            display_hash: display.sha256,
            display_ref: display,
          } as any);
          order.push(corrected ? "correction" : "original");
        } else order.push("probe");
      } else {
        const a = o.authorizations.at(-1)!,
          op = o.operations.at(-1)!;
        assert.equal(route, "authorizations/" + a.id + "/decision");
        assert.equal(body.display_hash, a.display_hash);
        if (body.decision === "APPROVE") {
          a.state = "CONSUMED";
          op.state = "SUCCEEDED";
          op.effect = "APPLIED";
          op.receipt = {
            ...f.save({ status: "COMMITTED", batch_id: op.action.intent_id }),
            media_type: "application/json",
          };
        } else {
          a.state = "REJECTED";
          op.state = "CANCELLED";
          op.effect = "NOT_STARTED";
        }
        order.push(String(body.decision));
      }
      return {
        request_id: body.request_id,
        command: route,
        state: "COMPLETED",
        acceptance: "ACCEPTED",
        resource_ids: ids,
        revision: "1",
        error_code: null,
      };
    },
  };
  await playStageScenario("C05-W", steps("C05-W"), host, t);
  assert.deepEqual(order, [
    "original",
    "REJECT",
    "correction",
    "APPROVE",
    "restart",
    "probe",
  ]);
  assert.equal(t.decisions[1].source, t.inputs[1].source_event);
  assert.notEqual(t.decisions[0].operation, t.decisions[1].operation);
});
