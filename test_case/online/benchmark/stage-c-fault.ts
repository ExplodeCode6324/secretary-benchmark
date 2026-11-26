import fs from "node:fs";
import path from "node:path";
import type { App } from "../../../sut/secretary/src/pi_secretary/src/app.ts";
import type {
  Execution,
  Operation,
  TaskPlan,
  ModelCall,
} from "../../../sut/secretary/src/pi_secretary/src/contracts.ts";
import { coreIdentity } from "../../../sut/secretary/src/pi_secretary/src/core-identity.ts";
import { stableID } from "../../../sut/secretary/src/pi_secretary/src/execution-utils.ts";
import type { WorkerPermit } from "./domain.ts";
import { completedFileWrite } from "./effect-proof.ts";
import { appendJSON, read, requireThat, sha, writeJSON } from "./io.ts";

export const delivery = {
  name: "continuity.txt",
  acceptance: ["One exact local write"],
  bytes: "alpha",
  goal: 'Write exactly the five UTF-8 bytes "alpha" to continuity.txt once. Do not send it.',
};
export const nativeWriteRecipe = "native-write-v1" as const;
export type C12bFixtureResponse =
  "shell" | "wrong-bytes" | "wrong-path" | "no-write";
export function isC12bFixtureResponse(
  value: unknown,
): value is C12bFixtureResponse {
  return (
    value === "shell" ||
    value === "wrong-bytes" ||
    value === "wrong-path" ||
    value === "no-write"
  );
}
export const nativeDelivery = {
  ...delivery,
  goal: 'Use the executor write tool to write exactly the five UTF-8 bytes "alpha" to continuity.txt once. Use the local workspace. Do not use shell commands or send the file.',
};
export const deliveryRequest = (
  run: string,
  recipe?: typeof nativeWriteRecipe,
) =>
  stableID(
    (recipe ? "issue122:C12b:native-write-v1:" : "issue122:C12b:") + run,
  );

function savedNativeWrite(app: App, call: ModelCall) {
  if (call.state !== "RESPONSE_SAVED" || !call.response) return false;
  const response = app.store.read<{
    content?: {
      type: string;
      name?: string;
      arguments?: { path?: string; content?: string };
    }[];
  }>(call.response);
  return response.content?.some(
    (part) =>
      part.type === "toolCall" &&
      part.name === "write" &&
      part.arguments?.path === delivery.name &&
      part.arguments?.content === delivery.bytes,
  );
}

export function recoveryTaskHasPriority(app: App, run: WorkerPermit) {
  const beforeBarrier = !fs.existsSync(
    path.join(run.evidence, "stage-c-barrier.json"),
  );
  return app.store.all<ModelCall>("ModelCall").some((call) => {
    if (!call.scope.execution_id) return false;
    if (call.state === "IN_FLIGHT") return true;
    if (!beforeBarrier || !savedNativeWrite(app, call)) return false;
    const execution = app.store.get<Execution>(
      "Execution",
      call.scope.execution_id,
    );
    return (
      app.store.get<TaskPlan>("TaskPlan", execution.task_id)
        .proposal_request_id === deliveryRequest(run.id, nativeWriteRecipe)
    );
  });
}

function parkWorker(): never {
  const latch = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(latch, 0, 0);
}
export function installStageCFault(
  app: App,
  run: WorkerPermit,
  park = parkWorker,
  gate?: { writing: boolean; check: () => boolean },
) {
  const auth = app.authorization;
  const dispatch = auth.dispatch.bind(auth);
  const finish = auth.finish.bind(auth);
  const evidence = (file: string) => path.join(run.evidence, file);
  const barrier = evidence("stage-c-barrier.json");
  const attempts = evidence("stage-c-write-attempts.jsonl");
  const writes = evidence("stage-c-physical-writes.jsonl");
  const fields = (op: Operation) => ({
    run: run.id,
    lineage: run.lineage,
    domain: coreIdentity(app.store).owner_id,
    request: app.store.get<TaskPlan>(
      "TaskPlan",
      app.store.get<Execution>("Execution", op.scope.execution_id!).task_id,
    ).proposal_request_id,
    execution: op.scope.execution_id,
    operation: op.id,
    resource: op.action.resource,
    parameter_hash: op.action.parameters_hash,
    expected_hash: sha(delivery.bytes),
    pid: process.pid,
    ...(gate
      ? {
          task_contexts: app.store
            .all<ModelCall>("ModelCall")
            .filter(
              (c) =>
                c.scope.execution_id === op.scope.execution_id &&
                savedNativeWrite(app, c),
            )
            .map((c) => c.request.sha256),
        }
      : {}),
  });
  const failureFile = evidence("stage-c-target-failure.json");
  const recordFailure = (operation: string, reason: string) => {
    if (!fs.existsSync(failureFile))
      writeJSON(failureFile, {
        run: run.id,
        request: deliveryRequest(run.id, nativeWriteRecipe),
        operation,
        reason,
      });
  };
  const refuse = (operation: string, reason: string): never => {
    recordFailure(operation, reason);
    throw Error(reason);
  };
  auth.dispatch = (id, extra) => {
    const op = app.store.get<Operation>("Operation", id);
    if (fs.existsSync(failureFile)) throw Error("C12B_TARGET_ALREADY_REFUSED");
    if (op.action.action !== "file.write" || !op.scope.execution_id)
      return refuse(op.id, "C12B_CAPABILITY_EXCLUDED");
    const exec = app.store.get<Execution>("Execution", op.scope.execution_id);
    const task = app.store.get<TaskPlan>("TaskPlan", exec.task_id);
    const proposal = app.store.read<any>(task.proposal_ref);
    const params = app.store.read<any>(op.action.parameters_ref);
    const native =
      task.proposal_request_id === deliveryRequest(run.id, nativeWriteRecipe);
    if (native && params.content !== delivery.bytes)
      return refuse(op.id, "C12B_WRONG_BYTES");
    if (native && params.path !== delivery.name)
      return refuse(op.id, "C12B_WRONG_PATH");
    if (!(
      (native || task.proposal_request_id === deliveryRequest(run.id)) &&
      proposal.request_id === task.proposal_request_id &&
      proposal.goal === (native ? nativeDelivery.goal : delivery.goal) &&
      exec.proposal_ref?.sha256 === task.proposal_ref.sha256 &&
      exec.workspace_binding &&
      typeof params.content === "string" &&
      params.path === delivery.name &&
      op.action.resource ===
        path.join(exec.workspace_binding.root_path, delivery.name)
    ))
      return refuse(op.id, "C12B_TARGET_UNBOUND");
    if (gate && !fs.existsSync(barrier)) {
      gate.writing = true;
      if (!gate.check()) return refuse(id, "C12B_SENDER_NOT_QUIESCENT");
    }
    appendJSON(attempts, fields(op));
    return dispatch(id, extra);
  };
  auth.finish = (id, receipt, outcome) => {
    // applyWrite converts thrown errors into durable UNKNOWN receipts. Hold the
    // synchronous finish hook on evidence errors until the supervisor stops it.
    try {
      const op = app.store.get<Operation>("Operation", id);
      if (
        op.action.action === "file.write" &&
        op.state === "DISPATCHED" &&
        outcome !== "UNKNOWN"
      ) {
        const proof = receipt as any;
        requireThat(
          completedFileWrite(
            op,
            receipt,
            outcome,
            () => read(op.action.resource),
            () => app.store.bytes(proof.evidence),
          ),
          "C12B_WRITE_PROOF",
        );
        const record = { ...fields(op), observed_hash: proof.evidence.sha256 };
        appendJSON(writes, record);
        if (!fs.existsSync(barrier)) {
          if (gate && record.observed_hash !== record.expected_hash) {
            recordFailure(id, "C12B_PREFAULT_CONTENT_MISMATCH");
            return park();
          }
          if (gate && (!gate.writing || !gate.check())) {
            recordFailure(id, "C12B_SENDER_NOT_QUIESCENT");
            return park();
          }
          writeJSON(barrier, record);
          process.kill(process.pid, "SIGKILL");
          return park();
        }
      }
    } catch {
      recordFailure(id, "C12B_WRITE_PROOF");
      return park();
    }
    return finish(id, receipt, outcome);
  };
}
