import path from "node:path";
import { randomUUID } from "node:crypto";
import { ledger } from "./campaign.ts";
import { appendJSON, requireThat } from "./io.ts";
import fs from "node:fs";
import { snapshot } from "./snapshot.ts";
import type { Run } from "./domain.ts";
import { cas, lines } from "./stage-b-scenarios-evidence.ts";
import { readJSON, writeJSON, read, sha } from "./io.ts";
import { CoreClient } from "../../../sut/secretary/src/pi_secretary/src/core-client.ts";
import { stableID } from "../../../sut/secretary/src/pi_secretary/src/execution-utils.ts";

export function retryTime(value: string | null, now = Date.now()) {
  if (!value) return null;
  const time = /^\d+$/.test(value)
    ? now + Number(value) * 1000
    : Date.parse(value);
  return Number.isFinite(time) && time <= 8.64e15
    ? new Date(Math.max(time, now)).toISOString()
    : null;
}
export class SenderWindowError extends Error {
  constructor(
    readonly waiting_for: string,
    readonly wait_started: number,
  ) {
    super("C12B_SENDER_WINDOW_EXHAUSTED");
  }
}
type Refusal = {
  lane?: string;
  run: string;
  role?: string;
  context_sha256?: string;
  model_call?: string;
  deadline?: number;
  started: number;
  reason: string;
  phase: string;
  request_sha256: string | null;
  reservation_id?: string;
  waiting_for?: string;
  wait_started?: number;
};
export function appendRefusal(root: string, refusal: Refusal) {
  const now = Date.now();
  const entries = [...ledger(root).entries.values()];
  appendJSON(path.join(root, "campaign", "facility-refusals.jsonl"), {
    ...refusal,
    id: randomUUID(),
    at: new Date(now).toISOString(),
    scope: "CALL",
    physical_send: refusal.phase === "AFTER_RESPONSE_BEFORE_DELIVERY",
    remaining_ms:
      refusal.deadline === undefined ? null : refusal.deadline - now,
    wait_ms: now - (refusal.wait_started ?? refusal.started),
    ledger_entries: entries.length,
    outstanding: entries.filter((entry) => !entry.settled).length,
  });
}

export function externalInterruption(root: string, run: Run, since: number) {
  const refusals = lines(
    path.join(root, "campaign", "facility-refusals.jsonl"),
  ).filter((row) => row.run === run.id && Date.parse(row.at) >= since);
  const entries = [...ledger(root).entries.values()].filter(
    (e) =>
      e.attempt.run === run.id &&
      Date.parse(e.attempt.at) >= since &&
      (!e.settled || externalOutcome(e.outcome)),
  );
  const incidents = [
    ...refusals.map((r) => ({ at: r.at, reason: r.reason, id: r.id })),
    ...entries.map((e) => ({
      at: e.attempt.at,
      reason: e.outcome ?? "IN_FLIGHT",
      id: e.attempt.id,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return incidents[0];
}
export function identityChanges(root: string, run: string) {
  return [...ledger(root).entries.values()].filter(
    (e) =>
      e.attempt.run === run &&
      /^(VERSION_TRANSITION|IDENTITY_UNKNOWN|IDENTITY_MISMATCH_FIRST_CONTACT)$/.test(
        (e.usage as { identity_status?: string } | null)?.identity_status ??
          e.outcome ??
          "",
      ),
  );
}
export function identitySequence(root: string, run: string) {
  return identityChanges(root, run).reduce(
    (sequence, e) => Math.max(sequence, e.settled_sequence ?? 0),
    0,
  );
}
export function requirePinnedIdentity(
  root: string,
  run: string,
  withheld?: () => Omit<Refusal, "reason" | "phase" | "run">,
) {
  const active = readJSON(path.join(root, "campaign", "active-stage-c.json"));
  if (
    active.run === run &&
    active.reviewed_identity_sequence >= identitySequence(root, run)
  )
    return;
  if (withheld)
    appendRefusal(root, {
      ...withheld(),
      run,
      reason: "GO_LANE_IDENTITY_PAUSED",
      phase: "AFTER_RESPONSE_BEFORE_DELIVERY",
    });
  throw Error("GO_LANE_IDENTITY_PAUSED");
}
export function providerRetryAt(root: string) {
  return Math.max(
    0,
    ...lines(path.join(root, "campaign", "provider-backoff.jsonl")).map(
      (r) => Date.parse(r.retry_at) || 0,
    ),
  );
}
export function nextDispatchTime(run: Run, now = Date.now()) {
  return Math.max(
    now + 1000,
    ...lines(path.join(run.evidence, "http.jsonl")).map(
      (row) => Date.parse(row.retry_at) || 0,
    ),
  );
}
export function boundModelBlock(root: string, run: Run) {
  if (!fs.existsSync(path.join(run.evidence, "observed.json"))) return;
  const observed = readJSON(path.join(run.evidence, "observed.json"));
  const session = observed.sessions.find(
    (s: any) => s.id === observed.session_id && s.state === "RECOVERY_BLOCKED",
  );
  if (!session) return;
  const cancelled =
    /^Error: MODEL_TRANSPORT_CANCELLED:([a-f0-9-]{36}): Error: CORE_STOPPING$/.exec(
      session.recovery_error ?? "",
    );
  if (cancelled && !session.model_blocked_call && run.endpoint) {
    const call = observed.calls.find(
      (c: any) =>
        c.id === cancelled[1] &&
        c.scope?.session_id === session.id &&
        c.state === "INTERRUPTED" &&
        c.failure_kind === "CANCELLED" &&
        c.error === "Error: CORE_STOPPING" &&
        !c.response,
    );
    if (
      call &&
      lines(path.join(root, "campaign", "stage-c-controller-stops.jsonl")).some(
        (stop) =>
          stop.run === run.id &&
          stop.domain === run.endpoint!.data_domain_id &&
          stop.started <= Date.parse(call.completed_at) &&
          Date.parse(call.completed_at) <= stop.ended,
      )
    )
      return { session, call };
  }
  const localID = /^Error: MODEL_TRANSPORT_LOCAL:([a-f0-9-]{36}):/.exec(
    session.recovery_error ?? "",
  )?.[1];
  const failedID = session.model_blocked_call ?? localID;
  const call = observed.calls.find(
    (c: any) =>
      c.id === failedID &&
      c.scope?.session_id === session.id &&
      c.state === "FAILED",
  );
  if (!call) return;
  const matching = [...ledger(root).entries.values()]
    .filter((entry) => {
      if (entry.attempt.run !== run.id || !entry.settled) return false;
      const file = path.join(
        run.evidence,
        "send-" + entry.attempt.id + ".json",
      );
      if (!fs.existsSync(file)) return false;
      const send = readJSON(file);
      return (
        send.id === entry.attempt.id &&
        send.model_call === call.id &&
        send.attribution?.context_sha256 === call.request.sha256
      );
    })
    .sort((a, b) => (b.settled_sequence ?? 0) - (a.settled_sequence ?? 0));
  const last = matching[0];
  const refused = lines(
    path.join(root, "campaign", "facility-refusals.jsonl"),
  ).some(
    (r) =>
      r.run === run.id &&
      r.model_call === call.id &&
      r.context_sha256 === call.request.sha256 &&
      (!last ||
        Date.parse(r.at) > Date.parse(last.settled_at!) ||
        (r.phase === "AFTER_RESPONSE_BEFORE_DELIVERY" &&
          r.reservation_id === last.attempt.id)),
  );
  if (!refused && !externalOutcome(last?.outcome)) return;
  return { session, call };
}
export function transientFacilityFailure(reason: string) {
  return /^(?:Error: )?(?:(?:ENOSPC|ENOMEM|EAGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT)(?:$|:| )|(?:spawn(?:Sync)? [^:\n]+ )(?:EAGAIN|ENOMEM)$|PG_TRANSIENT_(?:EAGAIN|ENOMEM|ENOSPC|ECONNREFUSED|ECONNRESET|ETIMEDOUT|53300|57P03)$)/.test(
    reason,
  );
}
export function resumableLaneFailure(reason: string, bound: boolean) {
  if (transientFacilityFailure(reason)) return true;
  return (
    bound &&
    /^(SCENARIO_PRODUCT_BLOCKED|RECOVERY_BLOCKED|C12B_SUPERVISOR_TIMEOUT|C12B_FAULT_PREREQUISITE_NOT_REACHED|WAIT_TIMEOUT)$/.test(
      reason,
    )
  );
}
export async function resumeModelBlock(root: string, run: Run) {
  const match = boundModelBlock(root, run);
  if (!match) return;
  const { session, call } = match;
  const request_id = stableID(
    [run.id, "session/resume", session.id, session.revision].join(":"),
  );
  const receipt = await new CoreClient(run.endpoint!).command(
    "session/resume",
    { request_id, expected_revision: String(session.revision) },
  );
  appendJSON(path.join(run.evidence, "stage-c-resumes.jsonl"), {
    request_id,
    call: call.id,
    session: session.id,
    revision: session.revision,
    acceptance: receipt.acceptance,
    at: new Date().toISOString(),
  });
  requireThat(
    receipt.acceptance === "ACCEPTED",
    "CONTINUATION_RESUME_REJECTED",
  );
}
export function externalOutcome(outcome: string | undefined) {
  if (outcome?.startsWith("HTTP_"))
    return /^HTTP_(401|402|403|408|429|5[0-9]{2})$/.test(outcome);
  return /UNCERTAIN|INTERRUPT|QUOTA|AUTH|GO_|NETWORK|IDENTITY|VERSION_TRANSITION|NO_POST|TIMEOUT/.test(
    outcome ?? "",
  );
}
export function confirmedSystemFailure(run: Run) {
  const file = path.join(run.evidence, "observed.json");
  if (!fs.existsSync(file)) return;
  const observed = readJSON(file),
    session = observed.sessions.find(
      (s: any) =>
        s.id === observed.session_id &&
        s.state === "RECOVERY_BLOCKED" &&
        !s.model_blocked_call,
    );
  if (
    !session ||
    !/^Error: (SUMMARY_SYSTEM_HASH_MISMATCH|CORRUPT_REVISION|CORRUPT_SNAPSHOT)$/.test(
      session.recovery_error ?? "",
    )
  )
    return;
  const core = path.join(run.active, "core");
  const tx = snapshot(core).transactions.find(
    (t) =>
      t.records.some(
        (r) =>
          r.record_type === "Session" &&
          r.id === session.id &&
          r.revision === session.revision &&
          r.recovery_error === session.recovery_error,
      ) &&
      t.events.some(
        (e) =>
          e.event_type === "host.blocked" &&
          cas(core, e.payload).error === session.recovery_error,
      ),
  );
  if (!tx) return;
  const evidence_file = "stage-c-system-failure.json";
  writeJSON(path.join(run.evidence, evidence_file), {
    run: run.id,
    lineage: run.lineage,
    session: session.id,
    revision: session.revision,
    reason: session.recovery_error,
    events: tx.events,
    observed_sha256: sha(read(file)),
  });
  return {
    schema: "issue122-secretary-system-failure-v1",
    reason: session.recovery_error,
    run: run.id,
    evidence_file,
    evidence_sha256: sha(read(path.join(run.evidence, evidence_file))),
  };
}
