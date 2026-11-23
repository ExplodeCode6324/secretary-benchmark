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
  bytes: "alpha",
  goal: 'Write exactly the five UTF-8 bytes "alpha" to continuity.txt once. Do not send it.',
};
export const deliveryRequest = (run: string) =>
  stableID("issue122:C12b:" + run);

export function installStageCFault(app: App, run: WorkerPermit) {
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
    request: deliveryRequest(run.id),
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
    requireThat(
      task.proposal_request_id === deliveryRequest(run.id) &&
        proposal.request_id === task.proposal_request_id &&
        proposal.goal === delivery.goal &&
        exec.proposal_ref?.sha256 === task.proposal_ref.sha256 &&
        exec.workspace_binding &&
        params.content === delivery.bytes &&
        params.path === delivery.name &&
        op.action.resource ===
          path.join(exec.workspace_binding.root_path, delivery.name),
      "C12B_TARGET_UNBOUND",
    );
    appendJSON(attempts, fields(op));
    return dispatch(id, extra);
  };
  auth.finish = (id, receipt, outcome) => {
    const op = app.store.get<Operation>("Operation", id);
    const proof = receipt as any;
    if (
      completedFileWrite(
        op,
        receipt,
        outcome,
        () => read(op.action.resource),
        () => app.store.bytes(proof.evidence),
      )
    ) {
      // Never let an evidence I/O error unwind into applyWrite's UNKNOWN catch.
      try {
        requireThat(
          proof.evidence.sha256 === sha(delivery.bytes),
          "C12B_BYTES",
        );
        const record = { ...fields(op), observed_hash: proof.evidence.sha256 };
        appendJSON(writes, record);
        if (!fs.existsSync(barrier)) {
          writeJSON(barrier, record);
          process.kill(process.pid, "SIGKILL");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
    }
    return finish(id, receipt, outcome);
  };
}
