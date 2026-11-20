import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { roleModel } from "../../../sut/secretary/src/pi_secretary/src/model.ts";
import {
  assertCampaignSource,
  createCampaign,
  ledger,
  loadCampaign,
} from "./campaign.ts";
import { credential, descriptor, meteredFetch } from "./live-model.ts";
import {
  appendJSON,
  mkdir,
  read,
  readJSON,
  requireThat,
  writeJSON,
} from "./io.ts";
import {
  stageLane,
  stageModels,
  stageSlots,
  checkAdmission,
  type PhysicalPolicy,
  type StageModel,
} from "./stage-b-policy.ts";
import {
  checkPublication,
  loadFreeze,
  type StageFreeze,
} from "./stage-b-freeze.ts";
import { Domains, type Run } from "./domain.ts";
import type { TimelineStep } from "./baseline-timeline.ts";

type Status =
  | "COMPLETED"
  | "INCOMPLETE"
  | "NOT_DISPATCHED_PREFLIGHT"
  | "UNRUN_CAMPAIGN_TIME"
  | "SKIPPED_CONTROL_QUOTA"
  | "BLOCKED_PRIMARY"
  | "STOPPED_BOUND_VIOLATION"
  | "VERSION_TRANSITION"
  | "HALTED"
  | "DEFERRED_BY_DECISION";
type Result = {
  status: Status;
  reason: string;
  at: string;
  episode?: string;
  run?: string;
  evidence?: string;
};
type Active = {
  lane: string;
  model: StageModel;
  episode: string;
  run?: string;
  freeze_sha256: string;
  state: "OPEN" | "CLOSED";
};
type State = {
  schema: "issue122-dispatch-v2";
  freeze_sha256: string;
  terminals: Record<string, Result>;
  probes: Record<string, Result>;
  repairs: Record<string, string>;
  ended: boolean;
  end_checked?: boolean;
  halt?: "PROVENANCE_CHANGE" | "OPERATOR" | "INFRASTRUCTURE";
};
type Entry =
  ReturnType<typeof ledger>["entries"] extends Map<string, infer Value>
    ? Value
    : never;
const directory = (root: string) => path.join(root, "campaign");
const stateFile = (root: string) =>
  path.join(directory(root), "stage-b-dispatch.json");
const activeFile = (root: string) =>
  path.join(directory(root), "active-stage-b.json");
const now = () => new Date().toISOString();
const result = (status: Status, reason: string): Result => ({
  status,
  reason,
  at: now(),
});
const allLanes = [
  ...stageModels.map((model) => stageLane("probe--" + model)!),
  ...stageSlots,
];
const table = (state: State, lane: string) =>
  lane.startsWith("probe--") ? state.probes : state.terminals;
const entries = (root: string) => [...ledger(root).entries.values()];
export const initialState = (
  hash: string,
  c16: StageFreeze["inputs"]["c16_decision"],
): State => {
  requireThat(
    c16 === "DISPATCH" || c16 === "DEFERRED_BY_DECISION",
    "STAGE_B_C16_DECISION_REQUIRED",
  );
  return {
    schema: "issue122-dispatch-v2",
    freeze_sha256: hash,
    terminals:
      c16 === "DISPATCH"
        ? {}
        : Object.fromEntries(
            stageSlots
              .filter((s) => s.scenario === "C16-combined")
              .map((s) => [
                s.lane,
                result("DEFERRED_BY_DECISION", "FROZEN_C16_DEFERRAL"),
              ]),
          ),
    probes: {},
    repairs: {},
    ended: false,
  };
};
export function stageState(root: string) {
  const campaign = loadCampaign(root);
  const state = readJSON<State>(stateFile(root));
  requireThat(
    state.schema === "issue122-dispatch-v2" &&
      campaign.physical_policy &&
      state.freeze_sha256 === campaign.physical_policy.freeze_sha256,
    "STAGE_B_DISPATCH_BINDING",
  );
  return state;
}
export function firstLaneFailure(records: Entry[], lane: string) {
  for (const record of records
    .filter((r) => r.attempt.lane === lane && r.settled)
    .sort((a, b) => a.settled_sequence! - b.settled_sequence!)) {
    if (record.component_violation)
      return result("STOPPED_BOUND_VIOLATION", "COMPONENT_OVERRUN");
    if (record.outcome === "PROVENANCE_CHANGE")
      return result("HALTED", "PROVENANCE_CHANGE");
    if (record.outcome === "VERSION_TRANSITION")
      return result("VERSION_TRANSITION", "RETURNED_MODEL_CHANGED");
    if (record.outcome === "EXHAUSTED_QUOTA")
      return result("INCOMPLETE", "INCOMPLETE_QUOTA");
    if (
      record.outcome === "AUTH" ||
      record.outcome === "IDENTITY_UNKNOWN" ||
      record.outcome === "IDENTITY_MISMATCH_FIRST_CONTACT"
    )
      return result("INCOMPLETE", record.outcome);
  }
}
function primaryBlock(state: State, records: Entry[]) {
  return records.find(
    (r) =>
      r.attempt.model === "deepseek-flash" &&
      ["EXHAUSTED_QUOTA", "AUTH"].includes(r.outcome ?? "") &&
      !state.repairs[r.attempt.id],
  );
}
export function beforeLane(
  state: State,
  records: Entry[],
  model: StageModel,
  clock: number,
): Result | "PAUSE" | undefined {
  const decisions: Result[] = [];
  for (const record of records) {
    if (record.pricing_drift)
      decisions.push({
        at: record.pricing_drift.at,
        status: "HALTED",
        reason: "PROVENANCE_CHANGE",
      });
  }
  for (const record of records
    .filter((row) => row.settled)
    .sort((a, b) => a.settled_sequence! - b.settled_sequence!)) {
    const at = record.settled_at ?? record.attempt.at;
    if (record.component_violation)
      decisions.push({
        at,
        status: "STOPPED_BOUND_VIOLATION",
        reason: "COMPONENT_OVERRUN",
      });
    else if (record.outcome === "PROVENANCE_CHANGE")
      decisions.push({ at, status: "HALTED", reason: "PROVENANCE_CHANGE" });
    else if (
      record.attempt.model === model &&
      (record.outcome === "IDENTITY_MISMATCH_FIRST_CONTACT" ||
        record.outcome === "IDENTITY_UNKNOWN")
    )
      decisions.push({
        at,
        status: "NOT_DISPATCHED_PREFLIGHT",
        reason: "IDENTITY_HOLD",
      });
    else if (
      record.attempt.model === model &&
      record.outcome === "VERSION_TRANSITION"
    )
      decisions.push({
        at,
        status: "NOT_DISPATCHED_PREFLIGHT",
        reason: "VERSION_HOLD",
      });
    else if (
      record.attempt.model === model &&
      model !== "deepseek-flash" &&
      record.outcome === "EXHAUSTED_QUOTA"
    )
      decisions.push({
        at,
        status: "SKIPPED_CONTROL_QUOTA",
        reason: "EXHAUSTED_QUOTA",
      });
  }
  if (records.length) {
    const expires = Date.parse(records[0].attempt.at) + 43200000;
    if (clock >= expires)
      decisions.push({
        at: new Date(expires).toISOString(),
        status: "UNRUN_CAMPAIGN_TIME",
        reason: "CAMPAIGN_TIME",
      });
  }
  if (state.halt) decisions.push(result("HALTED", state.halt));
  if (decisions.length)
    return decisions.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
  if (primaryBlock(state, records)) return "PAUSE";
}
function complete(root: string, state: State, lane: string, decision: Result) {
  const rows = table(state, lane);
  requireThat(!rows[lane], "STAGE_B_ALREADY_TERMINAL");
  rows[lane] = decision;
  writeJSON(stateFile(root), state);
}
export async function driveWorklist(
  state: State,
  getRecords: () => Entry[],
  run: (lane: (typeof allLanes)[number]) => Promise<void>,
  record: (lane: string, decision: Result) => void,
  terminate: boolean,
  clock = Date.now,
) {
  for (const lane of allLanes) {
    if (table(state, lane.lane)[lane.lane]) continue;
    const records = getRecords(),
      early = beforeLane(state, records, lane.model, clock());
    if (early === "PAUSE")
      return {
        state: "PAUSED_PRIMARY",
        attempt: primaryBlock(state, records)!.attempt.id,
      };
    if (early) {
      record(
        lane.lane,
        terminate &&
          primaryBlock(state, records) &&
          early.status === "HALTED" &&
          early.reason === "OPERATOR"
          ? result("BLOCKED_PRIMARY", "ACCOUNT_PAUSE_TERMINATED")
          : early,
      );
      continue;
    }
    await run(lane);
    requireThat(table(state, lane.lane)[lane.lane], "STAGE_B_TERMINAL_MISSING");
  }
}
export async function startStage(root: string, approval: string, hash: string) {
  const { policy, freeze } = loadFreeze(root, hash);
  for (const model of stageModels)
    checkAdmission(
      policy,
      [],
      "probe--" + model,
      model,
      "preflight",
      Date.now(),
    );
  await createCampaign(root, approval, undefined, undefined, policy);
  writeJSON(stateFile(root), initialState(hash, freeze.inputs.c16_decision));
}
async function publication(
  root: string,
  freeze: StageFreeze,
  model: StageModel,
  point: string,
) {
  const pages = freeze.inputs.sources[model];
  const at = now();
  try {
    await checkPublication(pages);
    appendJSON(path.join(directory(root), "publication.jsonl"), {
      point,
      model,
      at,
      pages,
      status: "MATCH",
    });
  } catch (error) {
    const changed =
      error instanceof Error && error.message === "STAGE_B_PROVENANCE_CHANGE";
    appendJSON(path.join(directory(root), "publication.jsonl"), {
      point,
      model,
      at,
      status: changed ? "CHANGED" : "UNAVAILABLE",
    });
    throw Error(changed ? "PROVENANCE_CHANGE" : "INFRASTRUCTURE");
  }
}
async function probe(root: string, active: Active) {
  const model = descriptor(active.model);
  const key = credential(active.model, true);
  const evidence = path.join(directory(root), "probes", active.episode);
  mkdir(evidence);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = meteredFetch(
      {
        root,
        run: active.episode,
        episode: active.episode,
        lane: active.lane,
        evidence,
        model: active.model,
        key,
        maxSends: 1,
        stageFreeze: active.freeze_sha256,
      },
      original,
    );
    const response = await (
      await roleModel(model, key).stream(
        model,
        normalizeContext({
          messages: [
            {
              role: "user",
              content: "Reply with READY.",
              timestamp: Date.now(),
            },
          ],
        }),
        { maxTokens: 128, signal: AbortSignal.timeout(30000) },
      )
    ).result();
    return !["error", "aborted"].includes(response.stopReason);
  } finally {
    globalThis.fetch = original;
  }
}
function deadline(records: Entry[], lane: string, clock: number) {
  if (records.length && clock >= Date.parse(records[0].attempt.at) + 43200000)
    return "CAMPAIGN_TIME";
  const first = records.find((r) => r.attempt.lane === lane);
  if (first && clock >= Date.parse(first.attempt.at) + 3600000)
    return "LANE_TIME";
}
function laneRefusal(root: string, active: Active): Result | undefined {
  const file = path.join(directory(root), "physical-refusals.jsonl");
  if (!fs.existsSync(file)) return;
  for (const line of read(file).toString().trimEnd().split("\n")) {
    const row = JSON.parse(line);
    if (
      row.lane === active.lane &&
      row.episode === active.episode &&
      row.freeze_sha256 === active.freeze_sha256
    )
      return { status: "INCOMPLETE", reason: row.reason, at: row.at };
  }
}
type ScenarioExecutor = (
  domains: Domains,
  run: Run,
  timeline: TimelineStep[],
  signal: AbortSignal,
) => Promise<{ completed: boolean; evidence?: string; reason?: string }>;
async function runLane(
  domains: Domains,
  state: State,
  freeze: StageFreeze,
  policy: PhysicalPolicy,
  lane: (typeof allLanes)[number],
  execute: ScenarioExecutor,
) {
  const { root } = domains;
  const active: Active = {
    state: "OPEN",
    model: lane.model,
    lane: lane.lane,
    episode: randomUUID(),
    freeze_sha256: policy.freeze_sha256,
  };
  let outcome: Result = result("INCOMPLETE", "INTERRUPTED"),
    evidence: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    checkAdmission(
      policy,
      entries(root).map((r) => r.attempt),
      lane.lane,
      lane.model,
      active.episode,
      Date.now(),
    );
    await publication(root, freeze, lane.model, lane.lane + ":start");
    let run: Run | undefined;
    if (lane.scenario !== "probe") {
      run = await domains.create({
        version: 2,
        track: "issue122",
        mode: "live",
        case_id: lane.scenario,
        seed: 122,
        model: lane.model,
        profile: lane.profile,
        lane: lane.lane,
        max_sends: lane.cap,
        freeze_sha256: policy.freeze_sha256,
      });
      active.run = run.id;
      active.episode = run.lineage;
    }
    writeJSON(activeFile(root), active);
    const controller = new AbortController();
    timer = setInterval(() => {
      try {
        const seen = entries(root);
        const reason =
          firstLaneFailure(seen, lane.lane)?.reason ??
          laneRefusal(root, active)?.reason ??
          deadline(seen, lane.lane, Date.now());
        if (reason) controller.abort(Error(reason));
      } catch {
        controller.abort(Error("INFRASTRUCTURE"));
      }
    }, 500);
    if (run) {
      const row = freeze.worklist.find((row) => row.lane === lane.lane)!;
      const execution = await execute(
        domains,
        run,
        row.timeline,
        controller.signal,
      );
      evidence = execution.evidence;
      outcome = execution.completed
        ? result("COMPLETED", "PROTOCOL_COMPLETE")
        : result("INCOMPLETE", execution.reason ?? "PARTIAL_TRIAL");
    } else
      outcome = (await probe(root, active))
        ? result("COMPLETED", "CONNECTIVITY_ONLY")
        : result("INCOMPLETE", "PROBE_FAILED");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const reserved = entries(root).some((r) => r.attempt.lane === lane.lane);
    if (["PROVENANCE_CHANGE", "INFRASTRUCTURE"].includes(message)) {
      state.halt = message as State["halt"];
      outcome = result("HALTED", message);
    } else
      outcome = result(
        reserved ? "INCOMPLETE" : "NOT_DISPATCHED_PREFLIGHT",
        /^[A-Z_]{1,80}$/.test(message) ? message : "HOST_FAILURE",
      );
  } finally {
    clearInterval(timer);
    writeJSON(activeFile(root), { ...active, state: "CLOSED" });
    if (active.run) {
      try {
        await domains.seal(active.run);
      } catch {
        state.halt = "INFRASTRUCTURE";
        outcome = result("HALTED", state.halt);
      }
    }
  }
  const records = entries(root),
    failure = firstLaneFailure(records, lane.lane),
    late = deadline(records, lane.lane, Date.parse(outcome.at));
  if (!state.halt && records.some((r) => r.attempt.lane === lane.lane)) {
    try {
      await publication(root, freeze, lane.model, lane.lane + ":end");
    } catch (error) {
      state.halt =
        error instanceof Error && error.message === "PROVENANCE_CHANGE"
          ? "PROVENANCE_CHANGE"
          : "INFRASTRUCTURE";
      outcome = result("HALTED", state.halt);
    }
  }
  const decisive =
    failure ??
    laneRefusal(root, active) ??
    (late ? result("INCOMPLETE", late) : outcome);
  complete(root, state, lane.lane, {
    ...decisive,
    episode: active.episode,
    run: active.run,
    ...(evidence ? { evidence } : {}),
  });
}
export async function dispatchStage(
  domains: Domains,
  approval: string,
  hash: string,
  execute: ScenarioExecutor,
  action: "dispatch" | "repair" | "stop" = "dispatch",
  repairID?: string,
) {
  domains.assertControllerLease();
  const { root } = domains;
  const state = stageState(root);
  const campaign = loadCampaign(root);
  requireThat(
    campaign.approval_id === approval && state.freeze_sha256 === hash,
    "STAGE_B_APPROVAL_MISMATCH",
  );
  if (state.ended)
    return { state: "ENDED", slots: Object.keys(state.terminals).length };
  if (campaign.state === "CLOSED") {
    requireThat(
      allLanes.every((lane) => table(state, lane.lane)[lane.lane]),
      "STAGE_B_PREMATURE_CLOSURE",
    );
    await domains.closeStoppedCampaign();
    state.ended = true;
    writeJSON(stateFile(root), state);
    return { state: "ENDED", slots: Object.keys(state.terminals).length };
  }
  assertCampaignSource(root);
  const { freeze, policy } = loadFreeze(root, hash);
  for (const slot of stageSlots.filter(
    (slot) => slot.scenario === "C16-combined",
  ))
    requireThat(
      (state.terminals[slot.lane]?.status === "DEFERRED_BY_DECISION") ===
        (freeze.inputs.c16_decision === "DEFERRED_BY_DECISION"),
      "STAGE_B_C16_DECISION_DRIFT",
    );
  if (fs.existsSync(activeFile(root))) {
    const previous = readJSON<Active>(activeFile(root));
    if (!table(state, previous.lane)[previous.lane]) {
      writeJSON(activeFile(root), { ...previous, state: "CLOSED" });
      if (previous.run) await domains.seal(previous.run);
      complete(root, state, previous.lane, {
        ...(firstLaneFailure(entries(root), previous.lane) ??
          result("INCOMPLETE", "CONTROLLER_INTERRUPTED")),
        episode: previous.episode,
      });
    }
  }
  const blocked = primaryBlock(state, entries(root));
  if (action === "repair") {
    requireThat(
      blocked && blocked.attempt.id === repairID,
      "STAGE_B_REPAIR_BINDING",
    );
    state.repairs[blocked.attempt.id] = now();
    writeJSON(stateFile(root), state);
    return { state: "REPAIR_RECORDED", attempt: blocked.attempt.id };
  }
  if (action === "stop") {
    state.halt ??= "OPERATOR";
    writeJSON(stateFile(root), state);
  }
  const pause = await driveWorklist(
    state,
    () => entries(root),
    (lane) => runLane(domains, state, freeze, policy, lane, execute),
    (lane, decision) => complete(root, state, lane, decision),
    action === "stop",
  );
  if (pause) return pause;
  if (!state.end_checked && entries(root).length) {
    let verified = true;
    for (const model of stageModels) {
      try {
        await publication(root, freeze, model, "campaign:end");
      } catch (error) {
        state.halt ??=
          error instanceof Error && error.message === "PROVENANCE_CHANGE"
            ? "PROVENANCE_CHANGE"
            : "INFRASTRUCTURE";
        verified = false;
      }
    }
    state.end_checked = verified;
  }
  await domains.closeStoppedCampaign();
  state.ended = true;
  writeJSON(stateFile(root), state);
  return {
    state: "ENDED",
    slots: Object.keys(state.terminals).length,
    halt: state.halt,
  };
}
