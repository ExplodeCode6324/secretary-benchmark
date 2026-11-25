import fs from "node:fs";
import path from "node:path";
import type { App } from "../../../sut/secretary/src/pi_secretary/src/app.ts";
import type {
  Execution,
  Operation,
  TaskPlan,
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
export type C12bFixtureResponse = "shell" | "wrong-bytes" | "no-write";
export function isC12bFixtureResponse(
  value: unknown,
): value is C12bFixtureResponse {
  return value === "shell" || value === "wrong-bytes" || value === "no-write";
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

function parkWorker(): never {
  const latch = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(latch, 0, 0);
}
export function installStageCFault(
  app: App,
  run: WorkerPermit,
  park = parkWorker,
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
  });
  auth.dispatch = (id, extra) => {
    const op = app.store.get<Operation>("Operation", id);
    requireThat(
      op.action.action === "file.write" && op.scope.execution_id,
      "C12B_CAPABILITY_EXCLUDED",
    );
    const exec = app.store.get<Execution>("Execution", op.scope.execution_id);
    const task = app.store.get<TaskPlan>("TaskPlan", exec.task_id);
    const proposal = app.store.read<any>(task.proposal_ref);
    const params = app.store.read<any>(op.action.parameters_ref);
    const native =
      task.proposal_request_id === deliveryRequest(run.id, nativeWriteRecipe);
    if (native && params.content !== delivery.bytes) {
      writeJSON(evidence("stage-c-target-failure.json"), {
        operation: op.id,
        request: task.proposal_request_id,
        reason: "C12B_WRONG_BYTES",
      });
      throw Error("C12B_WRONG_BYTES");
    }
    requireThat(
      (native || task.proposal_request_id === deliveryRequest(run.id)) &&
        proposal.request_id === task.proposal_request_id &&
        proposal.goal === (native ? nativeDelivery.goal : delivery.goal) &&
        exec.proposal_ref?.sha256 === task.proposal_ref.sha256 &&
        exec.workspace_binding &&
        typeof params.content === "string" &&
        params.path === delivery.name &&
        op.action.resource ===
          path.join(exec.workspace_binding.root_path, delivery.name),
      "C12B_TARGET_UNBOUND",
    );
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
          writeJSON(barrier, record);
          process.kill(process.pid, "SIGKILL");
          return park();
        }
      }
    } catch {
      return park();
    }
    return finish(id, receipt, outcome);
  };
}
