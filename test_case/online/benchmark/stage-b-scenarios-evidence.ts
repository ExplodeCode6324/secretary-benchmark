import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { stableID } from "../../../sut/secretary/src/pi_secretary/src/execution-utils.ts";
import type { Run } from "./domain.ts";
import { read, readJSON, requireThat, sha } from "./io.ts";
import { verifyRestart, effectVerdict } from "./baseline-evidence.ts";
import { ledger } from "./campaign.ts";
import { snapshot } from "./snapshot.ts";
import type { ScenarioTrail } from "./stage-b-scenarios-protocol.ts";

type Ref = { path: string; sha256: string; bytes: number };
export function casBytes(core: string, r: Ref) {
  requireThat(
    r && /^[a-f0-9]{64}$/.test(r.sha256) && r.path === "objects/" + r.sha256,
    "SCENARIO_CAS_REFERENCE",
  );
  const data = read(path.join(core, r.path));
  requireThat(
    data.length === r.bytes && sha(data) === r.sha256,
    "SCENARIO_CAS_CHANGED",
  );
  return data;
}
export function cas(core: string, r: Ref) {
  return JSON.parse(casBytes(core, r).toString());
}
export function lines(file: string): any[] {
  return fs.existsSync(file)
    ? read(file)
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}
function resultText(message: any): string {
  if (typeof message?.content === "string") return message.content;
  return (Array.isArray(message?.content) ? message.content : [])
    .flatMap((c: any) =>
      c.type === "text"
        ? [c.text]
        : c.type === "toolCall" && c.name === "MasterInteract"
          ? [c.arguments?.message ?? ""]
          : [],
    )
    .join("\n");
}
/** Direct byte observations only. Four-surface paraphrase review always remains a separate judgment. */
export function wireVisibility(payload: any) {
  const messages = payload.input ?? payload.messages;
  const markers = ["LIME-427", "Saturday", "redacted", "Thursday"];
  if (!Array.isArray(messages)) return { measured: false };
  const full = JSON.stringify(payload);
  const opaque =
    !!payload.previous_response_id ||
    /"encrypted_content"\s*:\s*"[^"]+|"type":"(?:item_reference|input_image|image_url)"/.test(
      full,
    );
  const buckets: Record<string, string[]> = {
    raw: [],
    echo: [],
    profile: [],
    consciousness: [],
    recall: [],
    other: [],
  };
  const collect = (s: string) => {
    for (const [tag, key] of [
      ["derived-world-profile", "profile"],
      ["world-recall-data", "recall"],
    ]) {
      s = s.replace(
        new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">", "g"),
        (_, inner: string) => {
          buckets[key].push(inner);
          return "";
        },
      );
    }
    buckets.other.push(s);
  };
  collect(String(payload.instructions ?? ""));
  for (const m of messages) {
    const value = JSON.stringify(m);
    if (["system", "developer"].includes(m.role)) collect(value);
    else if (
      m.role === "user" &&
      value.includes("Working memory (source history remains queryable):")
    )
      buckets.consciousness.push(value);
    else if (m.role === "user") buckets.raw.push(value);
    else if (
      ["assistant", "tool"].includes(m.role) ||
      ["function_call", "function_call_output", "reasoning"].includes(m.type)
    )
      buckets.echo.push(value);
    else buckets.other.push(value);
  }
  const hits = (s: string) =>
    markers.filter((marker) => s.toLowerCase().includes(marker.toLowerCase()));
  return {
    measured: true,
    opaque,
    wire_bytes: Buffer.byteLength(full),
    wire_sha256: sha(full),
    literal_hits: Object.fromEntries(
      Object.entries(buckets).map(([k, v]) => [k, hits(v.join("\n"))]),
    ),
    raw_projection_exit: opaque
      ? "UNKNOWN"
      : hits(buckets.raw.join("\n")).length
        ? "STILL_PRESENT"
        : "LITERAL_EXIT",
    echo_exit: opaque
      ? "UNKNOWN"
      : hits(buckets.echo.join("\n")).length
        ? "STILL_PRESENT"
        : "LITERAL_EXIT",
    all_literal_hits: hits(full),
    semantic_absence: "UNRESOLVED",
  };
}

export function memorySample(memory: any, job: any, subject: string) {
  const bytes = (v: any) => Buffer.byteLength(JSON.stringify(v));
  const items: any[] = memory.items;
  const targets = items.filter((i) =>
    JSON.stringify(i).toLowerCase().includes(subject.toLowerCase()),
  );
  const total = bytes(items);
  return {
    job: job.id,
    revision: memory.revision,
    covered: memory.covered_event_sequence,
    items_bytes: total,
    target_item_bytes: targets.reduce((n, i) => n + bytes(i), 0),
    target_item_share: targets.reduce((n, i) => n + bytes(i), 0) / total,
    items_sha256: sha(JSON.stringify(items)),
    target_items: targets.map((i) => ({
      id: i.item_id,
      sha256: sha(JSON.stringify(i)),
      source_hashes: i.source_refs.map((r: Ref) => r.sha256),
      last_activity_at: i.last_activity_at,
    })),
    candidate: job.candidate_ref?.sha256,
    source_events: job.source_event_ids,
    source_refs: job.source_refs.map((r: Ref) => r.sha256),
  };
}

type Frame = { records: any[]; events: any[] };
type Send = {
  id: string;
  at: string;
  payload: any;
  attribution: { role: string; context_sha256: string };
};
export function inspectStageEvidence(
  id: string,
  t: ScenarioTrail,
  frames: Frame[],
  object: (ref: Ref) => any,
  sends: Send[],
  writes: any[],
  session: string,
) {
  const records = frames.flatMap((f) => f.records);
  const latest = (type: string, key: string) =>
    records.findLast((r) => r.record_type === type && r.id === key);
  const events = frames.flatMap((f) => f.events);
  const contexts = events
    .filter(
      (e) => e.event_type === "model.context" && e.scope.session_id === session,
    )
    .map((e) => ({ e, c: object(e.payload) }))
    .filter(
      (v) => v.c.purpose === "MAIN" && v.c.capture_kind === "MODEL_REQUEST",
    );
  const captures = (v: (typeof contexts)[number]) => {
    const call = latest("ModelCall", v.c.call_id);
    if (!call || call.context_id !== v.c.id) return [];
    const match = sends.filter(
      (s) =>
        s.attribution?.role === "main" &&
        s.attribution.context_sha256 === call.request.sha256 &&
        s.at >= call.started_at &&
        (!call.completed_at || s.at <= call.completed_at),
    );
    return match.sort((a, b) => a.at.localeCompare(b.at));
  };
  const probe = t.inputs.find((i) => i.probe);
  const probeRequests = contexts.filter(
    (v) => v.c.loop_id === probe?.loop && v.c.input_ids.includes(probe?.id),
  );
  const first = probeRequests[0],
    probeSends = first ? captures(first) : [];
  const initial = probeSends[0];
  const snapped = (loop: string) =>
    frames.findIndex((f) =>
      f.records.some(
        (r) =>
          r.record_type === "MainPromptSnapshot" &&
          r.id === loop &&
          r.revision === 1,
      ),
    );
  const last = probeRequests
    .map((v) => latest("ModelCall", v.c.call_id))
    .filter((c) => c?.response)
    .at(-1);
  const outcome = {
    probe_input: probe?.id ?? null,
    probe_call: first?.c.call_id ?? null,
    probe_send: initial?.id ?? null,
    probe_payload: initial ? sha(JSON.stringify(initial.payload)) : null,
    probe_response: last?.response.sha256 ?? null,
  };
  const excerpts: { text: string; source_sha256: string; kind: string }[] = [];
  const setupCount =
    id === "C16-combined"
      ? 3
      : id === "C05-W"
        ? 2
        : id === "C08-inference" || id === "C10-model-created"
          ? 1
          : 0;
  for (const [index, input] of t.inputs.entries()) {
    if (!input.probe && index >= setupCount) continue;
    const rec = latest("Input", input.id);
    if (!rec || rec.payload.sha256 !== input.text_sha256) continue;
    const loop = contexts.filter(
      (v) => v.c.loop_id === rec.loop_id && v.c.input_ids.includes(input.id),
    );
    for (const v of loop) {
      const response = latest("ModelCall", v.c.call_id)?.response;
      if (!response) continue;
      const text = resultText(object(response));
      if (text)
        excerpts.push({
          kind: input.probe ? "probe_reply" : "setup_reply",
          text,
          source_sha256: response.sha256,
        });
    }
  }
  const requirements: string[] = [];
  if (probe && (!initial || !last)) requirements.push("PROBE_CAPTURE_MISSING");
  let world, maintenance, cold, task;
  if (id === "C05-W") {
    const approved = t.decisions.find((d) => d.decision === "APPROVE"),
      rejected = t.decisions.find((d) => d.decision === "REJECT");
    const op = approved && latest("Operation", approved.operation);
    const receipt = op?.receipt && object(op.receipt);
    const commit = frames.findIndex(
      (f) =>
        op &&
        f.records.some(
          (r) =>
            r.record_type === "Operation" &&
            r.id === op.id &&
            r.state === "SUCCEEDED" &&
            r.effect === "APPLIED",
        ) &&
        f.events.some(
          (e) =>
            e.event_type === "world.changed" &&
            isDeepStrictEqual(object(e.payload), receipt),
        ),
    );
    const event = frames[commit]?.events.find(
      (e) =>
        e.event_type === "world.changed" &&
        isDeepStrictEqual(object(e.payload), receipt),
    );
    const eligible =
      event &&
      contexts.find(
        (v) => v.e.sequence > event.sequence && snapped(v.c.loop_id) > commit,
      );
    const send = eligible && captures(eligible)[0];
    world = {
      rejected: rejected?.operation,
      approved: approved?.operation,
      commit_sequence: event?.sequence,
      receipt_sha256: op?.receipt?.sha256,
      first_eligible_sequence: eligible?.e.sequence,
      first_eligible_call: eligible?.c.call_id,
      first_eligible_payload: send ? sha(JSON.stringify(send.payload)) : null,
      first_eligible_response: eligible
        ? latest("ModelCall", eligible.c.call_id)?.response?.sha256
        : null,
      restart_observed: !!t.restart?.restart_observed,
    };
    if (
      !send ||
      !world.first_eligible_response ||
      !world.restart_observed ||
      !rejected ||
      latest("AuthorizationRequest", rejected.authorization)?.state !==
        "REJECTED" ||
      receipt?.status !== "COMMITTED" ||
      receipt.batch_id !== op.action.intent_id
    )
      requirements.push("WORLD_BOUNDARY_MISSING");
  }
  if (["C08-inference", "C09-finished", "C16-combined"].includes(id)) {
    const samples = t.cycles.flatMap((cycle) => {
      const f = frames.find((f) =>
        f.records.some(
          (r) =>
            r.record_type === "CompactionJob" &&
            r.id === cycle.job &&
            r.state === "COMMITTED" &&
            r.mode === "WORKING_MEMORY" &&
            r.session_id === session &&
            r.source_end_sequence >= cycle.boundary,
        ),
      );
      const c = f?.records.find(
        (r) =>
          r.record_type === "Consciousness" &&
          r.session_id === session &&
          r.last_job_id === cycle.job,
      );
      if (!c) return [];
      const job = f!.records.find((r) => r.id === cycle.job);
      for (const item of c.items)
        excerpts.push({
          kind: "working_memory_item",
          text: JSON.stringify({
            summary: item.summary,
            goals: item.goals,
            constraints: item.constraints,
            decisions: item.decisions,
            open_questions: item.open_questions,
          }),
          source_sha256: job.candidate_ref.sha256,
        });
      return [
        memorySample(
          c,
          job,
          id === "C08-inference"
            ? "Orchid"
            : id === "C09-finished"
              ? "Maple"
              : "Fern",
        ),
      ];
    });
    const attempts = records
      .filter(
        (r) =>
          r.record_type === "CompactionJob" &&
          r.session_id === session &&
          r.mode === "WORKING_MEMORY",
      )
      .map((j) => ({
        id: j.id,
        revision: j.revision,
        state: j.state,
        retry_round: j.retry_round,
        next_attempt_at: j.next_attempt_at,
      }));
    const setup = contexts.filter((v) => v.c.loop_id === t.inputs[0]?.loop);
    const setupOutputs = setup.flatMap((v) => {
      const call = latest("ModelCall", v.c.call_id);
      return call?.response
        ? [{ id: call.id, sha256: call.response.sha256 }]
        : [];
    });
    const prior = new Set(samples[0]?.target_items.map((i) => i.id));
    maintenance = {
      samples,
      attempts,
      first_failure: attempts.find((j) => j.state === "FAILED") ?? null,
      setup_outputs: setupOutputs,
      authority_chain: "UNRESOLVED",
      item_lineage: samples[1]?.target_items.some((i) => prior.has(i.id))
        ? "REVIEW_REQUIRED"
        : "NOT_TESTED",
    };
    if (
      samples.length !== 2 ||
      new Set(samples.map((c) => c.job)).size !== 2 ||
      samples[1].covered <= samples[0].covered
    )
      requirements.push("TWO_MAINTENANCE_COMMITS_MISSING");
  }
  if (id === "C16-combined") {
    const source = t.inputs[0];
    const sourceHashes = new Map<string, string>();
    if (source) {
      const accepted = events.find(
        (e) =>
          e.event_type === "input.accepted" &&
          e.event_id === source.source_event &&
          e.scope.session_id === session,
      );
      const input = accepted && object(accepted.payload);
      if (
        input?.id === source.id &&
        input.producer === "MASTER" &&
        input.payload.sha256 === source.text_sha256
      ) {
        sourceHashes.set(accepted.event_id, input.payload.sha256);
        const original = events.find(
          (e) =>
            e.event_type === "main.message" &&
            e.event_id === stableID("main.input.message:" + source.id) &&
            e.scope.session_id === session,
        );
        if (
          original &&
          object(original.payload).secretary_input?.input_id === input.id
        )
          sourceHashes.set(original.event_id, original.payload.sha256);
      }
    }
    const reads = probeRequests.flatMap((v) => {
      const call = latest("ModelCall", v.c.call_id);
      if (!call?.response || !captures(v).length) return [];
      const reply = object(call.response);
      return (reply.content ?? []).flatMap((part: any) => {
        if (
          part.type !== "toolCall" ||
          part.name !== "memory_read" ||
          part.arguments?.source !== "log" ||
          !sourceHashes.has(part.arguments.event_id)
        )
          return [];
        const result = events.find(
          (e) =>
            e.event_type === "main.tool.result" &&
            e.scope.session_id === session &&
            e.sequence > v.e.sequence &&
            (() => {
              const k = object(e.payload).key;
              return (
                typeof k === "string" &&
                k.startsWith(v.c.loop_id + ":") &&
                k.endsWith(
                  ":" +
                    part.id +
                    ":memory_read:" +
                    sha(JSON.stringify(part.arguments)),
                )
              );
            })(),
        );
        if (!result) return [];
        const tool = object(result.payload).result;
        let returned;
        try {
          returned = JSON.parse(resultText(tool));
        } catch {
          return [];
        }
        if (
          tool.isError ||
          returned.event_id !== part.arguments.event_id ||
          returned.body_hash !== sourceHashes.get(returned.event_id) ||
          !returned.body?.includes("LIME-427")
        )
          return [];
        const use = probeRequests.find((u) => {
          if (u.e.sequence <= result.sequence || !captures(u).length)
            return false;
          const next = latest("ModelCall", u.c.call_id);
          const request = next && object(next.request);
          return (
            request?.messages.some(
              (m: any) =>
                m.role === "toolResult" &&
                m.toolCallId === part.id &&
                m.toolName === "memory_read" &&
                !m.isError &&
                resultText(m) === resultText(tool),
            ) &&
            next.response &&
            resultText(object(next.response)).includes("LIME-427")
          );
        });
        return [
          {
            event: returned.event_id,
            result_sha256: result.payload.sha256,
            request_call: v.c.call_id,
            use_call: use?.c.call_id ?? null,
          },
        ];
      });
    });
    // The final unrelated activity request measures exit before restart. The probe measures it again afterwards.
    const before = t.inputs.filter((i) => !i.probe).at(-1);
    const pre = contexts.find(
      (v) => v.c.loop_id === before?.loop && v.c.input_ids.includes(before?.id),
    );
    const preSend = pre && captures(pre)[0];
    cold = {
      pre_restart_send: preSend?.id,
      pre_restart: preSend ? wireVisibility(preSend.payload) : null,
      probe: initial ? wireVisibility(initial.payload) : null,
      source_input: source?.id,
      source_event: source?.source_event,
      reads,
      restart_observed: !!t.restart?.restart_observed,
      natural_access: "UNRESOLVED",
    };
    if (!preSend || !initial || !cold.restart_observed)
      requirements.push("COLD_OBSERVATION_MISSING");
  }
  if (["C10-condition", "C10-answer", "C10-model-created"].includes(id)) {
    const bound = t.task,
      e = bound && latest("Execution", bound.execution);
    const ops = new Map(
      records
        .filter(
          (r) =>
            r.record_type === "Operation" && r.action.action === "file.write",
        )
        .map((r) => [r.id, r]),
    );
    const matching = writes.filter(
      (w) =>
        e &&
        w.execution_id === e.id &&
        w.resource === path.join(e.workspace_binding.root_path, "result.txt") &&
        ops.get(w.operation_id)?.scope?.execution_id === e.id &&
        ops.get(w.operation_id)?.action.resource === w.resource &&
        ops.get(w.operation_id)?.receipt &&
        ops.get(w.operation_id)?.effect === "APPLIED" &&
        object(ops.get(w.operation_id)!.receipt).evidence?.sha256 ===
          w.content_sha256 &&
        w.at >= bound!.release_at!,
    );
    const unknown = [...ops.values()].filter(
      (op) =>
        op.effect === "UNKNOWN" ||
        !["SUCCEEDED", "CANCELLED", "FAILED"].includes(op.state) ||
        (op.effect === "APPLIED" &&
          !writes.some((w) => w.operation_id === op.id)),
    ).length;
    const answered =
      bound?.question && latest("DecisionRequest", bound.question);
    const activationBound = !!bound && !!e && e.task_id === bound.task;
    const activated =
      activationBound &&
      (bound?.condition
        ? !!e?.condition_results.some(
            (r: any) =>
              r.condition_id === bound.condition && r.status === "MET",
          )
        : !!answered &&
          !!bound.answer_request &&
          answered.task_id === e.task_id &&
          answered.execution_id === e.id &&
          answered.state === "ANSWERED" &&
          answered.answered_by === "MASTER" &&
          answered.answer_request_id === bound?.answer_request);
    const settled =
      activationBound &&
      !!e.ended_at &&
      e.state === bound.terminal &&
      ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"].includes(e.state);
    task = {
      condition_met_or_answered: activated,
      diagnostics_version: 2,
      activation: activated
        ? "OBSERVED"
        : activationBound &&
            e &&
            ((bound?.condition &&
              e.condition_results.some(
                (r: any) =>
                  r.condition_id === bound.condition && r.status === "NOT_MET",
              )) ||
              (answered &&
                answered.task_id === e.task_id &&
                answered.execution_id === e.id &&
                answered.state === "OPEN"))
          ? "NOT_MET"
          : "UNKNOWN",
      pending_authorization_bound:
        e?.state === "WAIT_AUTH" &&
        records.some((record) => {
          if (
            record.record_type !== "AuthorizationRequest" ||
            latest(record.record_type, record.id) !== record
          )
            return false;
          const op = latest("Operation", record.operation_id);
          return (
            record.state === "PENDING" &&
            record.scope.execution_id === e.id &&
            record.scope.task_id === e.task_id &&
            e.task_id === bound?.task &&
            e.waiting_request_ids.includes(record.id) &&
            op?.state === "WAIT_AUTH" &&
            op.authorization_id === record.id &&
            isDeepStrictEqual(op.scope, record.scope) &&
            isDeepStrictEqual(op.action, record.action)
          );
        }),
      window_complete: settled,
      terminal: e?.state,
      physical_writes: writes.length,
      matching_writes: matching.length,
      unknown_writes: unknown,
      effects:
        writes.length !== matching.length
          ? "FAIL"
          : effectVerdict(1, writes.length, settled, unknown),
      activated_execution: e?.id,
      release_at: bound?.release_at,
      result_hashes: matching.map((w) => w.content_sha256),
      execution_result: e?.result_id ?? null,
      accepted_request: bound?.request,
      pre_release_wait_sequence: bound?.before_sequence,
      observed_condition: bound?.condition,
      observed_question: bound?.question,
    };
    if (!activated) requirements.push("TASK_ACTIVATION_MISSING");
    if (!task.window_complete) requirements.push("TASK_TERMINAL_MISSING");
  }
  return { requirements, outcome, world, maintenance, cold, task, excerpts };
}

export function auditStageRun(
  root: string,
  run: Run,
  t: ScenarioTrail,
  scenario?: string,
) {
  const core = path.join(run.active, "core"),
    state = snapshot(core),
    object = (r: Ref) => cas(core, r);
  if (t.restart) verifyRestart(t.restart, read);
  const sends = fs
    .readdirSync(run.evidence)
    .filter((f) => /^send-[a-f0-9-]+\.json$/.test(f))
    .map((f) => readJSON<Send>(path.join(run.evidence, f)));
  requireThat(
    run.config.version === 2 || run.config.version === 5,
    "SCENARIO_AUDIT_CONFIG",
  );
  const { entries } = ledger(root);
  for (const send of sends) {
    const a = entries.get(send.id)?.attempt;
    requireThat(
      a?.run === run.id &&
        a.episode === run.lineage &&
        a.lane === run.config.lane &&
        a.request_sha256 === sha(JSON.stringify(send.payload)),
      "SCENARIO_SEND_BINDING",
    );
  }
  const session = readJSON(path.join(run.evidence, "observed.json")).session_id;
  const proof = inspectStageEvidence(
    scenario ?? run.config.case_id,
    t,
    state.transactions,
    object,
    sends,
    lines(path.join(run.evidence, "completed-file-writes.jsonl")),
    session,
  );
  if (t.restart) {
    const old = readJSON(t.restart.old_exit.path),
      next = readJSON(t.restart.new_start.path);
    const sent =
      proof.outcome.probe_send &&
      sends.find((s) => s.id === proof.outcome.probe_send);
    requireThat(
      old.identity.token === run.id && next.identity.token === run.id,
      "SCENARIO_RESTART_DOMAIN",
    );
    if (!sent || sent.at < next.at)
      proof.requirements.push("SCENARIO_POST_RESTART_PROBE");
    if (proof.cold) {
      const before = sends.find((s) => s.id === proof.cold?.pre_restart_send);
      if (
        !before ||
        before.at > old.at ||
        !t.cycles.every((c) =>
          state.records.some((r) => r.id === c.job && r.updated_at <= old.at),
        )
      )
        proof.requirements.push("SCENARIO_PRE_RESTART_BOUNDARY");
    }
  }
  const events = state.transactions.flatMap((f) => f.events);
  const input_boundaries = t.inputs.map((i) => {
    const accepted = events.find(
      (e) =>
        e.event_type === "input.accepted" &&
        e.event_id === i.source_event &&
        e.scope.session_id === session,
    );
    const input = accepted && object(accepted.payload);
    const handled = events.find(
      (e) =>
        e.event_type === "input.handled" &&
        e.scope.session_id === session &&
        object(e.payload).inputs?.includes(i.id),
    );
    const rec = state.records.find(
      (r) => r.record_type === "Input" && r.id === i.id,
    );
    const bound =
      input?.id === i.id &&
      input.payload.sha256 === i.text_sha256 &&
      rec?.record_type === "Input" &&
      rec.state === "HANDLED" &&
      rec.loop_id === i.loop;
    if (!bound || !handled) proof.requirements.push("SCENARIO_INPUT_UNHANDLED");
    return {
      input_id: i.id,
      accepted_event: accepted?.event_id,
      accepted_sequence: accepted?.sequence,
      handled_event: handled?.event_id,
      handled_sequence: handled?.sequence,
      loop: i.loop,
    };
  });
  const operations = state.records
    .filter((r) => r.record_type === "Operation")
    .map((op) => ({
      id: op.id,
      execution: op.scope.execution_id,
      action: op.action.action,
      state: op.state,
      effect: op.effect,
      receipt: op.receipt?.sha256 ?? null,
    }));
  return {
    journal_digest: state.digest,
    input_boundaries,
    operations,
    ...proof,
  };
}
