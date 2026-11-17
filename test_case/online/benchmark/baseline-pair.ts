import path from "node:path";
import { Domains, type Run } from "./domain.ts";
import { snapshot } from "./snapshot.ts";
import { assertQuiescent } from "./baseline-evidence.ts";
import {
  readJSON,
  writeJSON,
  requireThat,
  sha,
  read,
  processStatus,
} from "./io.ts";
import { setFutureInputs } from "./payload-guard.ts";

export async function baselineQuiescence(run: Run, deadline: number) {
  let last = "",
    since = 0;
  while (Date.now() < deadline) {
    const o = readJSON(path.join(run.evidence, "observed.json"));
    try {
      assertQuiescent(o);
      requireThat(
        o.input_records.every((i: any) =>
          ["HANDLED", "WITHDRAWN"].includes(i.state),
        ),
        "BASELINE_INPUT_PENDING",
      );
      const key = String(o.sequence);
      if (key !== last) {
        last = key;
        since = Date.now();
      } else if (Date.now() - since >= 1000) return o;
    } catch {
      last = "";
      since = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error("BASELINE_QUIESCENCE_DEADLINE");
}

export function pairRestoreGuard(
  before: any[],
  after: any[],
  initialSink: unknown[],
  finalSink: unknown[],
  workerStopped: boolean,
) {
  requireThat(workerStopped, "BASELINE_PAIR_WORKER_UNCONFIRMED");
  const taskIDs = new Set(
    before.filter((r) => r.record_type === "TaskPlan").map((r) => r.id),
  );
  requireThat(
    !after.some((r) => r.record_type === "TaskPlan" && !taskIDs.has(r.id)),
    "BASELINE_PAIR_NEW_TASK",
  );
  const ops = new Map(
    before
      .filter((r) => r.record_type === "Operation")
      .map((r) => [r.id, JSON.stringify(r)]),
  );
  requireThat(
    !after.some(
      (r) =>
        r.record_type === "Operation" &&
        ops.get(r.id) !== JSON.stringify(r) &&
        (r.state === "RESULT_UNKNOWN" ||
          r.effect === "UNKNOWN" ||
          (r.effect === "APPLIED" &&
            ["file.write", "world.change"].includes(r.action?.action))),
    ),
    "BASELINE_PAIR_UNEXPECTED_EFFECT",
  );
  requireThat(
    JSON.stringify(initialSink) === JSON.stringify(finalSink),
    "BASELINE_PAIR_SINK_CHANGED",
  );
}

/** Exact existing source-A/one-restore-B protocol. No registry edits or extra restore primitive. */
export async function baselinePair(
  d: Domains,
  source: Run,
  options: {
    id: string;
    a_effectful: boolean;
    future_a: string[];
    future_b: string[];
    deadline: number;
  },
  probe: (run: Run, position: "A" | "B") => Promise<void>,
) {
  requireThat(!options.a_effectful, "BASELINE_EFFECTFUL_PROBE_MUST_BE_B");
  requireThat(
    source.state === "RUNNING" && /^[A-Za-z0-9_-]+$/.test(options.id),
    "BASELINE_PAIR_SOURCE",
  );
  const record = path.join(d.root, "pairs", options.id + ".json");
  // Exclusive pair identity. A failed pair remains evidence and cannot be retried as the same trial.
  const fs = await import("node:fs");
  requireThat(!fs.existsSync(record), "BASELINE_PAIR_ALREADY_ATTEMPTED");
  const receipt: any = {
    schema: "issue122-pair-v1",
    id: options.id,
    source: source.id,
    lineage: source.lineage,
    correlated_trials: 1,
    probes_post_restart: true,
    checkpoint: null,
    a: null,
    b: null,
    first_failure: null,
  };
  writeJSON(record, receipt);
  let current = source;
  try {
    await baselineQuiescence(source, options.deadline);
    const before = snapshot(path.join(source.active, "core")),
      sink = d.sink(source);
    const cp = await d.checkpoint(source.id);
    receipt.checkpoint = cp;
    receipt.checkpoint_sha256 = sha(
      read(path.join(d.root, "checkpoints", cp, "manifest.json")),
    );
    receipt.initial_digest = readJSON(
      path.join(d.root, "checkpoints", cp, "manifest.json"),
    ).journal.digest;
    writeJSON(record, receipt);
    setFutureInputs(d.root, source.lineage, options.future_a);
    current = await d.start(source.id);
    await baselineQuiescence(current, options.deadline);
    receipt.a = {
      run: current.id,
      process: current.process,
      restart: "DIRECT_SAME_DOMAIN",
      start_digest: snapshot(path.join(current.active, "core")).digest,
    };
    writeJSON(record, receipt);
    await probe(current, "A");
    await baselineQuiescence(current, options.deadline);
    current = await d.stop(current.id);
    const after = snapshot(path.join(current.active, "core"));
    receipt.a.final_digest = after.digest;
    pairRestoreGuard(
      before.records,
      after.records,
      sink,
      d.sink(current),
      !!current.process && processStatus(current.process) === "STOPPED",
    );
    await d.seal(current.id);
    receipt.a.seal_sha256 = sha(read(path.join(current.evidence, "seal.json")));
    writeJSON(record, receipt);
    current = await d.restore(source.id, cp);
    receipt.b = {
      run: current.id,
      parent: current.parent,
      restart: "CHECKPOINT_RESTORE",
      restored_digest: snapshot(path.join(current.active, "core")).digest,
    };
    requireThat(
      receipt.b.restored_digest === receipt.initial_digest,
      "BASELINE_PAIR_RESTORE_DRIFT",
    );
    writeJSON(record, receipt);
    setFutureInputs(d.root, current.lineage, options.future_b);
    current = await d.start(current.id);
    await baselineQuiescence(current, options.deadline);
    receipt.b.process = current.process;
    await probe(current, "B");
    await baselineQuiescence(current, options.deadline);
    receipt.b.final_digest = snapshot(path.join(current.active, "core")).digest;
  } catch (error) {
    receipt.first_failure =
      error instanceof Error ? error.message : "BASELINE_PAIR_FAILURE";
    throw error;
  } finally {
    writeJSON(record, receipt);
    // Stop only the currently owned incarnation; a failed guard never starts B.
    if (!["RETIRED", "CLEANED"].includes(d.raw(current.id).state))
      await d.seal(current.id);
  }
  return receipt;
}
