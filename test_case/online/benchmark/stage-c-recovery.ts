import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CoreClient } from "../../../sut/secretary/src/pi_secretary/src/core-client.ts";
import { type Domains, type Run } from "./domain.ts";
import { identityHash } from "./process-witness.ts";
import {
  processStatus,
  read,
  readJSON,
  requireThat,
  sha,
  until,
  writeJSON,
} from "./io.ts";
import { snapshot } from "./snapshot.ts";
import { lines } from "./stage-b-scenarios-evidence.ts";
import { delivery, deliveryRequest } from "./stage-c-fault.ts";
import { verifyRestart } from "./baseline-evidence.ts";

const windows = {
  target_ms: 20000,
  exit_ms: 8000,
  recovery_ms: 15000,
  post_verify_ms: 1500,
};
type Occurrence = {
  operation: string;
  resource: string;
  execution: string;
  run: string;
  lineage: string;
  domain: string;
  request: string;
  expected_hash: string;
  pid: number;
  observed_hash?: string;
};
export function countRecoveryWrites(
  attempts: Occurrence[],
  writes: Occurrence[],
  binding: Occurrence,
  unseen: boolean,
) {
  const same = (r: Occurrence) =>
    r.run === binding.run &&
    r.lineage === binding.lineage &&
    r.domain === binding.domain &&
    r.resource === binding.resource &&
    r.execution === binding.execution &&
    r.request === binding.request &&
    r.expected_hash === binding.expected_hash;
  if (
    writes.length > 1 ||
    writes.some((r) => !same(r) || r.observed_hash !== binding.expected_hash)
  )
    return "FAIL";
  if (
    unseen ||
    attempts.length !== 1 ||
    writes.length !== 1 ||
    !same(attempts[0]) ||
    attempts[0].operation !== binding.operation ||
    writes[0].operation !== binding.operation ||
    writes[0].pid !== binding.pid ||
    attempts[0].pid !== binding.pid
  )
    return "UNRESOLVED";
  return "PASS";
}
export function requireLostAck(
  history: { state: string; receipt?: unknown }[],
) {
  requireThat(
    history.at(-1)?.state === "DISPATCHED" &&
      history.every(
        (r) =>
          !r.receipt &&
          !["SUCCEEDED", "FAILED", "CANCELLED", "RESULT_UNKNOWN"].includes(
            r.state,
          ),
      ),
    "C12B_OLD_RESULT_ALREADY_PERSISTED_OR_DISPATCH_MISSING",
  );
}
export async function exerciseRecovery(d: Domains, old: Run) {
  const file = (name: string) => path.join(old.evidence, name);
  const core = path.join(old.active, "core");
  const client = new CoreClient(old.endpoint!);
  const request = deliveryRequest(old.id);
  const accepted = await client.command("task-requests", {
    request_id: request,
    goal: delivery.goal,
    acceptance: ["One exact local write"],
  });
  requireThat(
    accepted.acceptance === "ACCEPTED" && accepted.request_id === request,
    "C12B_REQUEST",
  );
  await until(
    () => fs.existsSync(file("stage-c-barrier.json")),
    windows.target_ms,
  );
  const bound: Occurrence = readJSON(file("stage-c-barrier.json"));
  requireThat(
    bound.run === old.id &&
      bound.lineage === old.lineage &&
      bound.domain === old.endpoint!.data_domain_id &&
      bound.request === request &&
      bound.pid === old.process!.pid &&
      bound.expected_hash === sha(delivery.bytes),
    "C12B_BINDING",
  );
  await until(() => processStatus(old.process) === "STOPPED", windows.exit_ms);
  await d.stop(old.id);
  const before = snapshot(core);
  requireLostAck(before.operationHistory.get(bound.operation) ?? []);
  const fresh = await d.start(old.id);
  requireThat(
    !fresh.parent &&
      !fresh.restoredFrom &&
      fresh.id === old.id &&
      fresh.lineage === old.lineage &&
      fresh.directoryIdentity === old.directoryIdentity &&
      fresh.active === old.active &&
      fresh.endpoint?.data_domain_id === bound.domain,
    "C12B_RESTART_DOMAIN",
  );
  const oldHash = identityHash(old.process),
    newHash = identityHash(fresh.process);
  const witness = (hash: string, state: string) => {
    const p = file("host-process-" + hash + "-" + state + ".json");
    return { path: p, sha256: sha(read(p)) };
  };
  const restart = verifyRestart(
    {
      kind: "DIRECT_SAME_DOMAIN",
      restart_observed: true,
      old_identity: oldHash,
      new_identity: newHash,
      old_exit: witness(oldHash, "STOPPED"),
      new_start: witness(newHash, "RUNNING"),
    },
    read,
  );
  const observed = () => readJSON(file("observed.json"));
  await until(
    () =>
      observed().operations.some(
        (op: any) =>
          op.id === bound.operation &&
          op.state === "RESULT_UNKNOWN" &&
          op.effect === "UNKNOWN",
      ),
    windows.recovery_ms,
  );
  const unknown = snapshot(core);
  const verifyID = randomUUID();
  const verify = await new CoreClient(fresh.endpoint!).command(
    "operations/" + bound.operation + "/verify-write",
    { request_id: verifyID },
  );
  requireThat(
    verify.request_id === verifyID && verify.acceptance === "ACCEPTED",
    "C12B_VERIFY_RECEIPT",
  );
  await until(
    () =>
      observed().operations.some(
        (op: any) =>
          op.id === bound.operation &&
          op.state === "SUCCEEDED" &&
          op.effect === "APPLIED",
      ),
    windows.recovery_ms,
  );
  await new Promise((resolve) => setTimeout(resolve, windows.post_verify_ms));
  await d.stop(old.id);
  const final = snapshot(core),
    history = final.operationHistory.get(bound.operation) ?? [];
  requireThat(
    history.at(-1)?.effect === "APPLIED" &&
      history.at(-1)?.state === "SUCCEEDED" &&
      unknown.operationHistory.get(bound.operation)?.at(-1)?.state ===
        "RESULT_UNKNOWN",
    "C12B_RECONCILIATION_HISTORY",
  );
  const attempts = lines(file("stage-c-write-attempts.jsonl")),
    writes = lines(file("stage-c-physical-writes.jsonl"));
  const unobserved = final.records.some(
    (op) =>
      op.record_type === "Operation" &&
      op.action.action === "file.write" &&
      (["DISPATCHED", "RESULT_UNKNOWN"].includes(op.state) ||
        (op.effect === "APPLIED" &&
          !writes.some((w) => w.operation === op.id))),
  );
  const effects = countRecoveryWrites(attempts, writes, bound, unobserved);
  const target = sha(read(bound.resource));
  requireThat(target === bound.expected_hash, "C12B_POSTCONDITION");
  const result = {
    expected: 1,
    physical_writes: writes.length,
    effects,
    host_assisted: true,
    kind: restart.kind,
    old_exit: restart.old_exit.sha256,
    new_start: restart.new_start.sha256,
    operation: bound.operation,
    pre_restart_journal: before.digest,
    unknown_journal: unknown.digest,
    final_journal: final.digest,
    verify_request: verifyID,
    verify_receipt_sha256: sha(JSON.stringify(verify)),
    content_sha256: target,
    windows,
  };
  writeJSON(file("stage-c-recovery-receipt.json"), {
    result,
    verify,
    restart,
    accepted,
    bound,
  });
  return result;
}
