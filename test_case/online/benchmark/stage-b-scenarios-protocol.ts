import { caseDefinition, trialTimeline } from "./stage-c-plan.ts";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AuthorizationRequest,
  CompactionJob,
  DecisionRequest,
  Execution,
  Input,
  ModelCall,
  Operation,
  TaskPlan,
} from "../../../sut/secretary/src/pi_secretary/src/contracts.ts";
import type { Receipt } from "../../../sut/secretary/src/pi_secretary/src/api/contracts.ts";
import { stableID } from "../../../sut/secretary/src/pi_secretary/src/execution-utils.ts";
import { baselineCases } from "./baseline-scenarios.ts";
import {
  fillerTexts,
  lintTimeline,
  timeline,
  visibleInputs,
  type TimelineStep,
} from "./baseline-timeline.ts";
import type { RestartEvidence } from "./baseline-evidence.ts";
import { requireThat, sha } from "./io.ts";

export type ScenarioObservation = {
  sequence: number;
  session_id: string;
  last_handled_sequence: number;
  input_records: Input[];
  input_events: { input_id: string; event_id: string }[];
  authorizations: AuthorizationRequest[];
  operations: Operation[];
  tasks: TaskPlan[];
  executions: Execution[];
  calls: ModelCall[];
  sessions: { state: string }[];
  feedback?: {
    id: string;
    state: string;
    kind: string;
    execution_id: string;
    task_id: string;
    result_id: string | null;
  }[];
  compactions: CompactionJob[];
};
export type ScenarioHost = {
  continuation?: {
    run: string;
    load(): { step:number; boundary:number; trail:ScenarioTrail } | null;
    save(step:number,boundary:number,trail:ScenarioTrail): void;
  };
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  observe(): ScenarioObservation;
  command(
    route: string,
    body: { request_id: string; [key: string]: unknown },
  ): Promise<Receipt>;
  object(ref: { path: string; sha256: string; bytes: number }): any;
  question(id: string): Promise<DecisionRequest>;
  modelProposed(loop: string, task: TaskPlan): boolean;
  writes(): {
    execution_id: string;
    operation_id: string;
    resource: string;
    content_sha256: string;
  }[];
  place(
    task: TaskPlan,
    execution: Execution,
    file: NonNullable<TimelineStep["file"]>,
  ): void;
  restart(signal?: AbortSignal): Promise<RestartEvidence>;
  guard(future: string[]): void;
  record(trail: ScenarioTrail): void;
};
export type ScenarioTrail = {
  inputs: {
    id: string;
    request: string;
    text_sha256: string;
    probe: boolean;
    source_event?: string;
    loop?: string;
  }[];
  decisions: {
    authorization: string;
    operation: string;
    source: string;
    decision: string;
    parameters_sha256: string;
    display_sha256: string;
    notes?: ReturnType<typeof worldNoteMetadata>[];
  }[];
  cycles: {
    job: string;
    through: number;
    boundary: number;
    attempts: string[];
  }[];
  task?: {
    request: string;
    task: string;
    execution: string;
    condition?: string;
    question?: string;
    answer_request?: string;
    model_created: boolean;
    before_sequence: number;
    release_at?: string;
    terminal?: string;
  };
  windows?: { start: number; end: number; tasks: string[]; writes: number }[];
  cancellation?: { request: string; command: string; execution: string };
  feedback?: { execution: string; task: string; id: string; result: string };
  restart?: RestartEvidence;
};
export const emptyTrail = (): ScenarioTrail => ({
  inputs: [],
  decisions: [],
  cycles: [],
});
const supported = [
  "C05-W",
  "C08-inference",
  "C10-condition",
  "C16-combined",
  "C10-answer",
  "C10-model-created",
];
export function validateScenario(id: string, steps: TimelineStep[]) {
  requireThat(supported.includes(id), "SCENARIO_UNSUPPORTED");
  const expected = timeline(baselineCases(true).find((c) => c.id === id)!);
  requireThat(steps.length === expected.length, "SCENARIO_TIMELINE");
  steps.forEach((step, i) => {
    const reference = expected[i];
    if (reference.filler) {
      const f = step.filler;
      requireThat(
        f &&
          Number.isInteger(f.count) &&
          f.count >= 1 &&
          f.count <= 160 &&
          Number.isInteger(f.bytes_each) &&
          f.bytes_each >= 128 &&
          f.bytes_each <= 65536 &&
          f.seed === reference.filler.seed,
        "SCENARIO_FILLER",
      );
      requireThat(
        isDeepStrictEqual({ ...step, filler: reference.filler }, reference),
        "SCENARIO_TIMELINE",
      );
    } else requireThat(isDeepStrictEqual(step, reference), "SCENARIO_TIMELINE");
  });
  lintTimeline(steps);
}

export const elmNote = "Juniper at Elm and June at Pine are distinct.";
type ElmTarget = { subject: string; fact: string };
function worldNoteMetadata(change: Record<string, unknown>) {
  const note = change.source_note;
  return typeof note === "string"
    ? { present: true, length: Array.from(note).length, sha256: sha(note) }
    : { present: false, length: null, sha256: null };
}

export function exactWorld(
  batch: any,
  source: string,
  corrected: boolean,
  elm?: true | ElmTarget,
) {
  if (elm && elm !== true) {
    return (
      /^[a-f0-9-]{36}$/.test(batch?.batch_id) &&
      isDeepStrictEqual(batch, {
        version: 1,
        batch_id: batch.batch_id,
        changes: [
          {
            intent: "RETRACT",
            subject: elm.subject,
            predicate: "entity.note",
            target_fact_id: elm.fact,
            source_event_ids: [source],
          },
        ],
      })
    );
  }
  const ref = batch?.changes?.[0]?.local_ref;
  if (
    !/^[a-f0-9-]{36}$/.test(batch?.batch_id) ||
    !/^\$[A-Za-z0-9_-]+$/.test(ref) ||
    !source
  )
    return false;
  const entity = {
    intent: "CREATE_ENTITY",
    local_ref: ref,
    entity_kind: "PROJECT",
    display_name: elm ? "Elm" : "Fern",
    source_event_ids: [source],
  };
  const value = elm
    ? elmNote
    : corrected
      ? "Fern pickup is Saturday. Only redacted copies may be collected."
      : "Fern pickup is Thursday.";
  if (!Array.isArray(batch.changes) || batch.changes.length !== 2) return false;
  const changes = [];
  for (const change of batch.changes) {
    if (!change || typeof change !== "object" || Array.isArray(change))
      return false;
    const { source_note, ...semantic } = change;
    if (
      Object.hasOwn(change, "source_note") &&
      (typeof source_note !== "string" || Array.from(source_note).length > 2000)
    )
      return false;
    changes.push(semantic);
  }
  return isDeepStrictEqual(
    { ...batch, changes },
    {
      version: 1,
      batch_id: batch.batch_id,
      changes: [
        entity,
        {
          intent: "ASSERT",
          subject: ref,
          predicate: "entity.note",
          topic: "current_context",
          value,
          keywords: [],
          source_event_ids: [source],
        },
      ],
    },
  );
}
export function checkedWorld(
  host: ScenarioHost,
  o: ScenarioObservation,
  source: string,
  corrected: boolean,
  elm?: true | ElmTarget,
) {
  const pending = o.authorizations.filter((a) => a.state === "PENDING");
  if (!pending.length) return;
  const [a] = pending;
  const op = o.operations.find((p) => p.id === a.operation_id);
  requireThat(
    pending.length === 1 &&
      op?.state === "WAIT_AUTH" &&
      op.authorization_id === a.id &&
      op.scope.session_id === o.session_id &&
      !op.scope.execution_id &&
      op.action.action === "world.change" &&
      isDeepStrictEqual(op.action, a.action) &&
      isDeepStrictEqual(op.scope, a.scope) &&
      op.action.parameters_ref.sha256 === op.action.parameters_hash &&
      a.display_ref.sha256 === a.display_hash,
    "SCENARIO_WORLD_BINDING",
  );
  const batch = host.object(op.action.parameters_ref),
    preview = host.object(a.display_ref);
  requireThat(
    exactWorld(batch, source, corrected, elm) &&
      op.action.intent_id === batch.batch_id &&
      op.action.resource === "world/batch/" + batch.batch_id &&
      isDeepStrictEqual(preview, {
        scope: op.scope,
        action: op.action,
        parameters: batch,
      }),
    "SCENARIO_WORLD_BATCH",
  );
  return {
    a,
    op,
    notes: batch.changes.map(worldNoteMetadata) as ReturnType<
      typeof worldNoteMetadata
    >[],
  };
}
function idle(o: ScenarioObservation) {
  return (
    o.sessions.length > 0 &&
    o.sessions.every((s) => s.state === "IDLE") &&
    o.input_records.every((i) => ["HANDLED", "WITHDRAWN"].includes(i.state)) &&
    !o.calls.some((c) => ["PREPARED", "IN_FLIGHT"].includes(c.state))
  );
}
export function checkAbort(signal?: AbortSignal) {
  requireThat(!signal?.aborted, "SCENARIO_ABORTED");
}

/** A fresh run, a single ordered timeline, and exactly the same controller for fixture and Secretary. */
export async function playStageScenario(
  id: string,
  steps: TimelineStep[],
  h: ScenarioHost,
  t: ScenarioTrail,
  signal?: AbortSignal,
) {
  validateScenario(id, steps);
  return play(id, steps, h, t, signal);
}

export async function playCurrentScenario(
  id: string,
  purpose: "OFFLINE_FIXTURE" | "BASELINE",
  recipe: { count: number; bytes_each: number } | undefined,
  host: ScenarioHost,
  trail: ScenarioTrail,
  portion: "FULL" | "PAIR_SOURCE" | "PAIR_PROBE" = "FULL",
  signal?: AbortSignal,
) {
  const c = caseDefinition(id);
  requireThat(
    !["C06-stale-cold", "C12b"].includes(id),
    "SCENARIO_SPECIAL_DRIVER_REQUIRED",
  );
  const steps = trialTimeline(c, purpose, recipe);
  lintTimeline(steps);
  const boundary = steps.findIndex((s) => s.action === "PAIRED_RESTART");
  requireThat(
    c.pair ? portion !== "FULL" && boundary >= 0 : portion === "FULL",
    "SCENARIO_PAIR_ROUTE",
  );
  return play(
    id,
    portion === "PAIR_SOURCE"
      ? steps.slice(0, boundary)
      : portion === "PAIR_PROBE"
        ? steps.slice(boundary + 1)
        : steps,
    host,
    trail,
    signal,
  );
}
async function play(
  id: string,
  steps: TimelineStep[],
  h: ScenarioHost,
  t: ScenarioTrail,
  signal?: AbortSignal,
) {
  let lastInput: ScenarioTrail["inputs"][number] | undefined;
  let request: string | undefined,
    condition: string | undefined,
    typedTask: string | undefined;
  let decision: DecisionRequest | undefined,
    boundary = 0;
  let task: TaskPlan | undefined, execution: Execution | undefined;
  let elmTarget: ElmTarget | undefined;
  let waitLimit = 0, step = 0, ordinal = 0;
  const checkpoint = h.continuation?.load();
  if (checkpoint) {
    Object.assign(t, checkpoint.trail);
    lastInput=t.inputs.at(-1);
    boundary=checkpoint.boundary;
  }
  const wait = async <T>(
    code: string,
    fn: (o: ScenarioObservation) => T | undefined,
  ): Promise<T> => {
    while (h.now() < waitLimit) {
      checkAbort(signal);
      const o = h.observe();
      requireThat(
        !o.sessions.some((s) =>
          ["RECOVERY_BLOCKED", "CAPACITY_BLOCKED"].includes(s.state),
        ),
        "SCENARIO_PRODUCT_BLOCKED",
      );
      const value = fn(o);
      if (value !== undefined) return value;
      await h.sleep(Math.min(200, waitLimit - h.now()), signal);
    }
    throw Error(code);
  };
  const command = async (route: string, body: Record<string, unknown>) => {
    checkAbort(signal);
    const request_id = h.continuation ? stableID([h.continuation.run, step, ordinal++, route, sha(JSON.stringify(body))].join(":")) : randomUUID();
    const r = await h.command(route, { ...body, request_id });
    requireThat(
      r.request_id === request_id &&
        r.acceptance === "ACCEPTED" &&
        !["UNKNOWN", "FAILED"].includes(r.state),
      "SCENARIO_COMMAND_RECEIPT",
    );
    return r;
  };
  const message = async (text: string, probe: boolean, settle: boolean) => {
    const r = await command("messages", { text });
    const ids = r.resource_ids.filter((v) => v.type === "Input");
    requireThat(ids.length === 1, "SCENARIO_INPUT_RECEIPT");
    const input = {
      id: ids[0].id,
      request: r.request_id,
      text_sha256: sha(text),
      probe,
    };
    lastInput = input;
    t.inputs.push(input);
    h.record(t);
    const observed = await wait("SCENARIO_INPUT_UNHANDLED", (o) => {
      const i = o.input_records.find((i) => i.id === input.id);
      const e = o.input_events.find((e) => e.input_id === input.id);
      if (
        !i?.loop_id ||
        !e ||
        i.session_id !== o.session_id ||
        i.producer !== "MASTER" ||
        i.payload.sha256 !== input.text_sha256
      )
        return;
      if (settle && (i.state !== "HANDLED" || !idle(o))) return;
      return { loop: i.loop_id, source_event: e.event_id };
    });
    Object.assign(input, observed);
  };
  const bindWait = async () => {
    const result = await wait("SCENARIO_TASK_WAIT_MISSING", (o) => {
      const plans = o.tasks.filter(
        (p) =>
          p.state === "ACTIVE" &&
          (request
            ? p.proposal_request_id === request &&
              (!typedTask || p.id === typedTask)
            : true),
      );
      requireThat(plans.length <= 1, "SCENARIO_AMBIGUOUS_TASK");
      const plan = plans[0];
      if (!plan) return;
      const es = o.executions.filter((e) => e.task_id === plan.id);
      requireThat(es.length <= 1, "SCENARIO_AMBIGUOUS_EXECUTION");
      const e = es[0];
      if (!e || e.state !== (condition ? "WAIT_PRECONDITION" : "WAIT_DECISION"))
        return;
      const proposal = h.object(plan.proposal_ref);
      requireThat(
        plan.proposal_ref.sha256 === e.proposal_ref?.sha256 &&
          proposal.request_id === plan.proposal_request_id,
        "SCENARIO_PROPOSAL_BINDING",
      );
      if (condition) {
        const expected = [
          {
            condition_id: condition,
            kind: "RESOURCE_PRESENT",
            target: id === "C13-imported_note" ? "linden.txt" : "ready.txt",
            required_revision: null,
          },
        ];
        requireThat(
          isDeepStrictEqual(plan.preconditions, expected) &&
            isDeepStrictEqual(proposal.preconditions, expected) &&
            e.condition_results.length === 1 &&
            e.condition_results[0].condition_id === condition &&
            e.condition_results[0].status === "NOT_MET",
          "SCENARIO_CONDITION_BINDING",
        );
      } else
        requireThat(
          e.waiting_request_ids.length === 1,
          "SCENARIO_QUESTION_BINDING",
        );
      requireThat(
        !o.operations.some((op) => op.action.action === "file.write") &&
          h.writes().length === 0,
        "SCENARIO_PREMATURE_WRITE",
      );
      if (!request)
        requireThat(
          lastInput?.loop && h.modelProposed(lastInput.loop, plan),
          "SCENARIO_MODEL_CREATION_UNPROVEN",
        );
      return { plan, e, seq: o.sequence };
    });
    if (t.task)
      requireThat(
        t.task.task === result.plan.id &&
          t.task.execution === result.e.id &&
          (!t.task.question ||
            result.e.waiting_request_ids[0] === t.task.question),
        "SCENARIO_TASK_IDENTITY_CHANGED",
      );
    task = result.plan;
    execution = result.e;
    t.task = {
      request: task.proposal_request_id,
      task: task.id,
      execution: execution.id,
      model_created: !request,
      condition,
      before_sequence: result.seq,
    };
    if (!condition) {
      checkAbort(signal);
      decision = await h.question(execution.waiting_request_ids[0]);
      requireThat(
        decision.id === execution.waiting_request_ids[0] &&
          decision.state === "OPEN" &&
          decision.task_id === task.id &&
          decision.execution_id === execution.id &&
          !!decision.question,
        "SCENARIO_QUESTION_BINDING",
      );
      t.task.question = decision.id;
    }
  };
  const future = steps.map((s) => visibleInputs([s]));
  for (let ix = 0; ix < steps.length; ix++) {
    if (checkpoint && ix < checkpoint.step) continue;
    step=ix; ordinal=0;
    checkAbort(signal);
    const s = steps[ix],
      next = steps[ix + 1];
    waitLimit = h.now() + Math.min(s.seconds ?? 600, 600) * 1000;
    h.guard(future.slice(ix + 1).flat());
    if (s.action === "MASTER_MESSAGE")
      await message(
        s.text!,
        !!s.probe,
        !(["C05-W", "C14-retraction"].includes(id) && !s.probe) &&
          !(id === "C10-model-created" && !s.probe),
      );
    else if (s.action === "MASTER_TASK") {
      const body = structuredClone(s.payload!);
      if (Array.isArray(body.preconditions)) {
        condition = randomUUID();
        body.preconditions = body.preconditions.map((p) => ({
          ...p,
          condition_id: condition,
        }));
      }
      const r = await command("task-requests", body);
      request = r.request_id;
      typedTask = r.resource_ids.find((v) => v.type === "TaskPlan")?.id;
    } else if (s.action === "MASTER_AUTHORIZATION") {
      const corrected = s.payload!.decision === "APPROVE",
        source = lastInput!.source_event!;
      if (id === "C14-retraction" && t.decisions.length)
        requireThat(elmTarget, "SCENARIO_RETRACTION_TARGET");
      const { a, op, notes } = await wait(
        "SCENARIO_WORLD_PROPOSAL_MISSING",
        (o) =>
          checkedWorld(
            h,
            o,
            source,
            corrected,
            id === "C14-retraction"
              ? t.decisions.length
                ? elmTarget
                : true
              : undefined,
          ),
      );
      await command("authorizations/" + a.id + "/decision", {
        expected_revision: String(a.revision),
        display_hash: a.display_hash,
        decision: s.payload!.decision,
      });
      t.decisions.push({
        authorization: a.id,
        operation: op.id,
        source,
        decision: String(s.payload!.decision),
        parameters_sha256: op.action.parameters_hash,
        display_sha256: a.display_hash,
        notes,
      });
      h.record(t);
      await wait("SCENARIO_WORLD_DECISION_UNSETTLED", (o) => {
        const current = o.operations.find((p) => p.id === op.id);
        const auth = o.authorizations.find((v) => v.id === a.id);
        if (corrected) {
          if (
            current?.state !== "SUCCEEDED" ||
            current.effect !== "APPLIED" ||
            !current.receipt ||
            auth?.state !== "CONSUMED"
          )
            return;
          const receipt = h.object(current.receipt);
          requireThat(
            receipt.status === "COMMITTED" &&
              receipt.batch_id === op.action.intent_id,
            "SCENARIO_WORLD_RECEIPT",
          );
          if (id === "C14-retraction" && t.decisions.length === 1) {
            requireThat(
              receipt.result_ids?.length === 2 &&
                receipt.result_ids.every(
                  (v: unknown) =>
                    typeof v === "string" && /^[a-f0-9-]{36}$/.test(v),
                ),
              "SCENARIO_ELM_TARGET",
            );
            elmTarget = {
              subject: receipt.result_ids[0],
              fact: receipt.result_ids[1],
            };
          }
        } else if (
          auth?.state !== "REJECTED" ||
          !current ||
          !["CANCELLED", "FAILED"].includes(current.state) ||
          !["NOT_STARTED", "NOT_APPLIED"].includes(current.effect)
        )
          return;
        return idle(o) ? true : undefined;
      });
    } else if (s.action === "UNRELATED_ACTIVITY") {
      const messages = fillerTexts(s.filler!);
      for (const [index, text] of messages.entries()) {
        waitLimit = h.now() + 600_000;
        h.guard([...messages.slice(index + 1), ...future.slice(ix + 1).flat()]);
        await message(text, false, true);
      }
      boundary = h.observe().last_handled_sequence;
    } else if (s.action === "IDLE_WAIT")
      await h.sleep(s.seconds! * 1000, signal);
    else if (s.action === "OBSERVE") {
      if (
        id === "C10-discussed" ||
        (id.startsWith("C11-") && ix === steps.length - 1)
      ) {
        const start = h.now(),
          tasks = new Set<string>();
        while (h.now() < waitLimit) {
          checkAbort(signal);
          h.observe().tasks.forEach((task) => tasks.add(task.id));
          await h.sleep(Math.min(1000, waitLimit - h.now()), signal);
        }
        (t.windows ??= []).push({
          start,
          end: h.now(),
          tasks: [...tasks],
          writes: h.writes().length,
        });
      } else if (steps[ix - 1].action === "IDLE_WAIT") {
        const covered = await wait("SCENARIO_MAINTENANCE_BOUNDARY", (o) => {
          const jobs = o.compactions.filter(
            (j) =>
              j.session_id === o.session_id &&
              j.mode === "WORKING_MEMORY" &&
              (j.source_end_sequence ?? 0) >= boundary &&
              !t.cycles.some((c) => c.job === j.id),
          );
          const j = jobs.find(
            (j) =>
              j.state === "COMMITTED" &&
              j.source_event_ids.includes(
                stableID("main.input.message:" + lastInput!.id),
              ),
          );
          if (j && boundary > 0)
            return {
              job: j.id,
              through: j.source_end_sequence!,
              boundary,
              attempts: jobs.map((j) => j.id),
            };
        });
        t.cycles.push(covered);
      } else if (
        (id.startsWith("C11-") && steps[ix - 1]?.action === "MASTER_TASK") ||
        (next?.action === "SCRIPTED_FILE" &&
          steps[ix - 1]?.action !== "MASTER_MESSAGE") ||
        next?.action === "MASTER_ANSWER"
      )
        await bindWait();
      else if (id.startsWith("C13-") && request) {
        const result = await wait("SCENARIO_TASK_FEEDBACK_MISSING", (o) => {
          const plan = o.tasks.find(
            (p) =>
              p.proposal_request_id === request &&
              (!typedTask || p.id === typedTask),
          );
          const exec =
            plan &&
            o.executions.find(
              (e) => e.task_id === plan.id && e.state === "SUCCEEDED",
            );
          return (
            exec &&
            o.feedback?.find(
              (f) =>
                f.kind === "RESULT" &&
                f.execution_id === exec.id &&
                f.task_id === plan!.id &&
                f.result_id &&
                ["DELIVERED", "HANDLED"].includes(f.state),
            )
          );
        });
        t.feedback = {
          execution: result.execution_id,
          task: result.task_id,
          id: result.id,
          result: result.result_id!,
        };
      } else if (t.task?.release_at) {
        const e = await wait("SCENARIO_TASK_UNSETTLED", (o) =>
          o.executions.find(
            (e) =>
              e.id === t.task!.execution &&
              e.task_id === t.task!.task &&
              ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"].includes(e.state),
          ),
        );
        t.task.terminal = e.state;
      }
      // World authorizations and cold exit are measured against the actual request, never an extra observation prompt.
    } else if (s.action === "SCRIPTED_FILE") {
      requireThat(
        task && execution && t.task && condition,
        "SCENARIO_TASK_BINDING",
      );
      if (id === "C11-autonomous-invalidation") {
        const o = h.observe();
        const e = o.executions.find(
          (v) => v.id === execution!.id && v.task_id === task!.id,
        );
        requireThat(e, "SCENARIO_TASK_BINDING");
        execution = e;
      } else await bindWait();
      checkAbort(signal);
      const at = new Date(h.now()).toISOString();
      h.place(task, execution, s.file!);
      t.task.release_at = at;
    } else if (s.action === "MASTER_CANCEL") {
      requireThat(
        t.task && request && t.task.request === request && t.task.condition,
        "SCENARIO_CANCEL_BINDING",
      );
      const receipt = await command("task-requests/" + request + "/cancel", {});
      requireThat(
        receipt.resource_ids.some(
          (v) => v.type === "TaskPlan" && v.id === t.task!.task,
        ),
        "SCENARIO_CANCEL_RECEIPT",
      );
      t.cancellation = {
        request,
        command: receipt.request_id,
        execution: t.task.execution,
      };
      t.task.release_at = new Date(h.now()).toISOString();
    } else if (s.action === "MASTER_ANSWER") {
      await bindWait();
      requireThat(t.task && decision, "SCENARIO_QUESTION_BINDING");
      t.task.release_at = new Date(h.now()).toISOString();
      t.task.answer_request = (
        await command("decisions/" + decision.id + "/answer", s.payload!)
      ).request_id;
    } else if (s.action === "DIRECT_RESTART") {
      checkAbort(signal);
      t.restart = await h.restart(signal);
    } else throw Error("SCENARIO_ACTION_UNSUPPORTED");
    h.record(t);
    h.continuation?.save(ix+1,boundary,t);
  }
}
