import fs from "node:fs";
import path from "node:path";
import { stableID } from "../../../sut/secretary/src/pi_secretary/src/execution-utils.ts";
import { randomUUID } from "node:crypto";
import type {
  TaskPlan,
  Execution,
  Operation,
} from "../../../sut/secretary/src/pi_secretary/src/contracts.ts";
import { CoreClient } from "../../../sut/secretary/src/pi_secretary/src/core-client.ts";
import { type Domains, type Run } from "./domain.ts";
import { identityHash } from "./process-witness.ts";
import {
  processStatus,
  stopOwned,
  read,
  readJSON,
  requireThat,
  sha,
  until,
  writeJSON,
} from "./io.ts";
import { snapshot } from "./snapshot.ts";
import { lines } from "./stage-b-scenarios-evidence.ts";
import {
  delivery,
  deliveryRequest,
  nativeDelivery,
  nativeWriteRecipe,
} from "./stage-c-fault.ts";
import { type RestartEvidence, verifyRestart } from "./baseline-evidence.ts";

const fixtureWindows = {
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
export function verifyDirectRecovery(
  old: Run,
  fresh: Run,
  domain: string,
  evidence: RestartEvidence,
  bytes: (p: string) => Buffer,
) {
  requireThat(
    evidence.kind === "DIRECT_SAME_DOMAIN" &&
      evidence.old_identity === identityHash(old.process) &&
      evidence.new_identity === identityHash(fresh.process) &&
      !fresh.parent &&
      !fresh.restoredFrom &&
      fresh.id === old.id &&
      fresh.lineage === old.lineage &&
      fresh.directoryIdentity === old.directoryIdentity &&
      fresh.active === old.active &&
      fresh.endpoint?.data_domain_id === domain,
    "C12B_RESTART_DOMAIN",
  );
  return verifyRestart(evidence, bytes);
}
/** Stop only the recorded incarnation; retain the first diagnosis even when cleanup fails. */
export async function superviseRecovery<T>(
  run: Pick<Run, "process">,
  failure: string,
  timeout: number,
  action: () => Promise<T>,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(Error("C12B_SUPERVISOR_TIMEOUT")),
        timeout,
      );
    });
    return await Promise.race([action(), deadline]);
  } catch (error) {
    const errors = [error];
    try {
      if (!fs.existsSync(failure))
        writeJSON(failure, { error: String(error), process: run.process });
    } catch (persist) {
      errors.push(persist);
    }
    try {
      requireThat(
        (await stopOwned(run.process)) === "STOPPED",
        "C12B_SUPERVISOR_STOP_UNCONFIRMED",
      );
    } catch (cleanup) {
      errors.push(cleanup);
    }
    if (errors.length > 1) throw new AggregateError(errors, String(error));
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
export async function exerciseRecovery(
  d: Domains,
  old: Run,
  windows = fixtureWindows,
  probe?: string,
  guard?: (future: string[]) => void,
  taskRecipe?: typeof nativeWriteRecipe,
  continuing = false,
) {
  const file = (name: string) => path.join(old.evidence, name);
  const core = path.join(old.active, "core");
  const client = new CoreClient(old.endpoint!);
  const request = deliveryRequest(old.id, taskRecipe);
  const task = taskRecipe ? nativeDelivery : delivery;
  const supervise = <T>(
    run: Run,
    action: () => Promise<T>,
    timeout = windows.target_ms,
  ) =>
    superviseRecovery(
      run,
      file("stage-c-supervisor-failure.json"),
      timeout,
      action,
    );
  const waitForFault = (check: () => boolean, ms: number, missing: string) =>
    supervise(old, async () => {
      try {
        await until(check, ms);
      } catch (e) {
        if (String(e) === "Error: WAIT_TIMEOUT") throw Error(missing);
        throw e;
      }
    });
  guard?.(probe ? [probe] : []);
  const saved = (name: string) =>
    continuing && fs.existsSync(file(name)) ? readJSON(file(name)) : null;
  const accepted =
    saved("stage-c-task-accepted.json") ??
    (await supervise(old, async () => {
      const receipt = await client.command("task-requests", {
        request_id: request,
        goal: task.goal,
        acceptance: task.acceptance,
      });
      requireThat(
        receipt.acceptance === "ACCEPTED" && receipt.request_id === request,
        "C12B_REQUEST",
      );
      if (continuing) writeJSON(file("stage-c-task-accepted.json"), receipt);
      return receipt;
    }));
  await waitForFault(
    () => {
      const failurePath = file("stage-c-target-failure.json");
      if (taskRecipe && fs.existsSync(failurePath)) {
        const failure = readJSON(failurePath);
        requireThat(
          failure.run === old.id &&
            failure.request === request &&
            typeof failure.operation === "string" &&
            [
              "C12B_WRONG_BYTES",
              "C12B_WRONG_PATH",
              "C12B_TARGET_UNBOUND",
              "C12B_CAPABILITY_EXCLUDED",
              "C12B_WRITE_PROOF",
              "C12B_SENDER_NOT_QUIESCENT",
              "C12B_PREFAULT_CONTENT_MISMATCH",
            ].includes(failure.reason),
          "C12B_FAILURE_BINDING",
        );
        throw Error(failure.reason);
      }
      if (fs.existsSync(file("stage-c-barrier.json"))) return true;
      const observedPath = file("observed.json");
      if (taskRecipe && fs.existsSync(observedPath)) {
        const observed = readJSON(observedPath);
        const taskIDs = new Set(
          observed.tasks
            .filter((t: TaskPlan) => t.proposal_request_id === request)
            .map((t: TaskPlan) => t.id),
        );
        const targetExecutions = (observed.executions as Execution[]).filter(
          (e) => taskIDs.has(e.task_id),
        );
        const executions = new Set(targetExecutions.map((e) => e.id));
        requireThat(
          !targetExecutions.some((e) =>
            ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"].includes(e.state),
          ),
          "C12B_FINISHED_WITHOUT_WRITE",
        );
        for (const op of observed.operations as Operation[]) {
          if (
            op.state === "WAIT_AUTH" &&
            op.scope.execution_id &&
            executions.has(op.scope.execution_id)
          ) {
            throw Error(
              op.action.action === "shell.run"
                ? "C12B_SHELL_REQUESTED"
                : "C12B_UNEXPECTED_AUTHORIZATION",
            );
          }
        }
      }
      return false;
    },
    windows.target_ms,
    "C12B_FAULT_PREREQUISITE_NOT_REACHED",
  );
  const bound: Occurrence = readJSON(file("stage-c-barrier.json"));
  const savedRestart = saved("stage-c-restart-checkpoint.json");
  const { fresh, restart, pre_restart_journal } = savedRestart
    ? {
        fresh: old,
        restart: verifyRestart(savedRestart.restart, read),
        pre_restart_journal: savedRestart.pre_restart_journal,
      }
    : await (async () => {
        const faultProcess = old.process!;
        requireThat(
          bound.run === old.id &&
            bound.lineage === old.lineage &&
            bound.domain === old.endpoint!.data_domain_id &&
            bound.request === request &&
            bound.pid === faultProcess.pid &&
            bound.expected_hash === sha(delivery.bytes),
          "C12B_BINDING",
        );
        await waitForFault(
          () => processStatus(old.process) === "STOPPED",
          windows.exit_ms,
          "C12B_SELF_EXIT_UNCONFIRMED",
        );
        await d.stop(old.id);
        const before = snapshot(core);
        requireLostAck(before.operationHistory.get(bound.operation) ?? []);
        const fresh = await d.start(old.id);
        const oldHash = identityHash(old.process),
          newHash = identityHash(fresh.process);
        const witness = (hash: string, state: string) => {
          const p = file("host-process-" + hash + "-" + state + ".json");
          return { path: p, sha256: sha(read(p)) };
        };
        const restart = verifyDirectRecovery(
          old,
          fresh,
          bound.domain,
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
        const checkpoint = { restart, pre_restart_journal: before.digest };
        if (continuing)
          writeJSON(file("stage-c-restart-checkpoint.json"), checkpoint);
        return { fresh, ...checkpoint };
      })();
  const observed = () => readJSON(file("observed.json"));
  const verifyID = continuing
    ? stableID(request + ":verify-write")
    : randomUUID();
  let verify: Awaited<ReturnType<CoreClient["command"]>> | undefined;
  let unknownDigest: string | null = null;
  let reconciled = false;
  let probeInput: string | null = null;
  let recoveryFailure: string | null = null;
  try {
    await supervise(
      fresh,
      async () => {
        const savedUnknown = saved("stage-c-unknown-checkpoint.json");
        if (savedUnknown) unknownDigest = savedUnknown.digest;
        else {
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
          requireThat(
            unknown.operationHistory.get(bound.operation)?.at(-1)?.state ===
              "RESULT_UNKNOWN",
            "C12B_UNKNOWN_HISTORY",
          );
          unknownDigest = unknown.digest;
          if (continuing)
            writeJSON(file("stage-c-unknown-checkpoint.json"), {
              digest: unknownDigest,
              operation: bound.operation,
            });
        }
        verify = await supervise(
          fresh,
          () =>
            new CoreClient(fresh.endpoint!).command(
              "operations/" + bound.operation + "/verify-write",
              { request_id: verifyID },
            ),
          windows.recovery_ms,
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
        if (probe) {
          guard?.([]);
          const request_id = continuing
            ? stableID(request + ":probe")
            : randomUUID();
          const r = await supervise(
            fresh,
            () =>
              new CoreClient(fresh.endpoint!).command("messages", {
                request_id,
                text: probe,
              }),
            windows.recovery_ms,
          );
          const input = r.resource_ids.find((i) => i.type === "Input")?.id;
          requireThat(
            r.acceptance === "ACCEPTED" && r.request_id === request_id && input,
            "C12B_PROBE_BINDING",
          );
          probeInput = input;
          await until(
            () =>
              observed().input_records.some(
                (i: any) => i.id === input && i.state === "HANDLED",
              ),
            windows.recovery_ms,
          );
        }
        await new Promise((resolve) =>
          setTimeout(resolve, windows.post_verify_ms),
        );
        await supervise(fresh, () => d.stop(old.id), windows.exit_ms + 30000);
        reconciled = true;
      },
      windows.recovery_ms * 5 +
        windows.post_verify_ms +
        windows.exit_ms +
        31000,
    );
  } catch (e) {
    requireThat(
      processStatus(fresh.process) === "STOPPED",
      "C12B_SUPERVISOR_STOP_UNCONFIRMED",
    );
    recoveryFailure = String(e);
    await d.stop(old.id);
  }
  const final = snapshot(core);
  const last = final.operationHistory.get(bound.operation)?.at(-1);
  reconciled =
    reconciled && last?.state === "SUCCEEDED" && last.effect === "APPLIED";
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
  const effects = countRecoveryWrites(
    attempts,
    writes,
    bound,
    unobserved || !reconciled,
  );
  const target = fs.existsSync(bound.resource)
    ? sha(read(bound.resource))
    : null;
  const result = {
    expected: 1,
    physical_writes: writes.length,
    effects:
      effects === "PASS" && target !== bound.expected_hash
        ? "UNRESOLVED"
        : effects,
    reconciled,
    first_recovery_failure: recoveryFailure,
    host_assisted: true,
    kind: restart.kind,
    old_exit: restart.old_exit.sha256,
    new_start: restart.new_start.sha256,
    operation: bound.operation,
    pre_restart_journal,
    unknown_journal: unknownDigest,
    final_journal: final.digest,
    verify_request: verifyID,
    probe_input: probeInput,
    verify_receipt_sha256: verify ? sha(JSON.stringify(verify)) : null,
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
