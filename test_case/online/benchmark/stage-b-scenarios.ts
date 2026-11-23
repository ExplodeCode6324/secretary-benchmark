import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CoreClient } from "../../../sut/secretary/src/pi_secretary/src/core-client.ts";
import { stableID } from "../../../sut/secretary/src/pi_secretary/src/execution-utils.ts";
import { Domains, type Run } from "./domain.ts";
import {
  noLinks,
  read,
  readJSON,
  requireThat,
  sha,
  syncDir,
  writeJSON,
} from "./io.ts";
import { snapshot } from "./snapshot.ts";
import { verifyRestart } from "./baseline-evidence.ts";
import { identityHash } from "./process-witness.ts";
import { setFutureInputs } from "./payload-guard.ts";
import { visibleInputs, type TimelineStep } from "./baseline-timeline.ts";
import { auditStageRun, cas, lines } from "./stage-b-scenarios-evidence.ts";
import {
  checkAbort,
  emptyTrail,
  playStageScenario,
  validateScenario,
  type ScenarioHost,
} from "./stage-b-scenarios-protocol.ts";

export type StageScenarioResult = {
  completed: boolean;
  reason?: string;
  evidence: string;
};

export const placeStageFile: (
  core: string,
  ...args: Parameters<ScenarioHost["place"]>
) => void = (core, task, e, file) => {
  requireThat(
    /^[a-f0-9-]{36}$/.test(task.id) &&
      (file.path === "ready.txt" ||
        (file.path === "linden.txt" &&
          task.preconditions.some(
            (p) => p.kind === "RESOURCE_PRESENT" && p.target === file.path,
          ))) &&
      sha(file.content) === file.sha256 &&
      e.task_id === task.id &&
      (e.state === "WAIT_PRECONDITION" ||
        (file.path === "ready.txt" &&
          e.state === "CANCELLED" &&
          task.preconditions.some(
            (p) => p.kind === "RESOURCE_PRESENT" && p.target === file.path,
          ))),
    "SCENARIO_FILE_BINDING",
  );
  const owner = path.join(core, "workspaces", task.id);
  requireThat(
    e.workspace_binding?.kind === "NONE" &&
      e.workspace_binding.root_path === path.join(owner, "work") &&
      readJSON(path.join(owner, "workspace.json")).task_id === task.id,
    "SCENARIO_WORKSPACE_OWNER",
  );
  const target = path.join(e.workspace_binding.root_path, file.path);
  noLinks(target);
  const out = fs.openSync(target, "wx", 0o400);
  try {
    fs.writeFileSync(out, file.content);
    fs.fsyncSync(out);
  } finally {
    fs.closeSync(out);
  }
  syncDir(e.workspace_binding.root_path);
  requireThat(sha(read(target)) === file.sha256, "SCENARIO_FILE_CHANGED");
};

export function secretaryHost(
  d: Domains,
  source: Run,
  progress = "stage-b-progress.json",
): ScenarioHost {
  let run = source;
  const core = path.join(source.active, "core");
  const client = () => new CoreClient(run.endpoint!);
  return {
    now: Date.now,
    sleep: (ms, signal) => delay(ms, undefined, { signal }),
    command: (route, body) => client().command(route, body),
    observe: () => readJSON(path.join(run.evidence, "observed.json")),
    object: (ref) => cas(core, ref),
    question: async (id) => client().query("decisions/" + id),
    modelProposed(loop, task) {
      return snapshot(core).transactions.some((f) =>
        f.events.some((e) => {
          if (e.event_type !== "main.tool.result") return false;
          const p = cas(core, e.payload);
          return (
            typeof p.key === "string" &&
            p.key.startsWith(loop + ":") &&
            p.key.includes(":task_propose:") &&
            stableID(p.key) === task.proposal_request_id
          );
        }),
      );
    },
    writes: () => lines(path.join(run.evidence, "completed-file-writes.jsonl")),
    place: (...args) => placeStageFile(core, ...args),
    guard: (future) => setFutureInputs(d.root, run.lineage, future),
    record: (trail) => writeJSON(path.join(run.evidence, progress), trail),
    async restart(signal) {
      const old = run;
      checkAbort(signal);
      await d.stop(old.id);
      checkAbort(signal);
      run = await d.start(old.id);
      requireThat(
        old.endpoint?.data_domain_id === run.endpoint?.data_domain_id &&
          old.id === run.id &&
          old.lineage === run.lineage &&
          old.process &&
          run.process,
        "SCENARIO_RESTART_DOMAIN",
      );
      const old_identity = identityHash(old.process),
        new_identity = identityHash(run.process);
      const witness = (hash: string, state: string) => {
        const file = path.join(
          run.evidence,
          "host-process-" + hash + "-" + state + ".json",
        );
        return { path: file, sha256: sha(read(file)) };
      };
      return verifyRestart(
        {
          kind: "DIRECT_SAME_DOMAIN",
          restart_observed: true,
          old_identity,
          new_identity,
          old_exit: witness(old_identity, "STOPPED"),
          new_start: witness(new_identity, "RUNNING"),
        },
        read,
      );
    },
  };
}

/** Dispatcher owns freeze, active-lane admission and sealing. Only the four pilot cases start real workers. */
export async function executeStageScenario(
  domains: Domains,
  run: Run,
  timelineSteps: TimelineStep[],
  signal?: AbortSignal,
): Promise<StageScenarioResult> {
  requireThat(
    run.config.version === 2 &&
      run.config.track === "issue122" &&
      !run.parent &&
      run.state === "STOPPED" &&
      !run.process &&
      ["C05-W", "C08-inference", "C10-condition", "C16-combined"].includes(
        run.config.case_id,
      ),
    "SCENARIO_REQUIRES_FRESH_STAGE_RUN",
  );
  validateScenario(run.config.case_id, timelineSteps);
  const progress = path.join(run.evidence, "stage-b-progress.json"),
    packet = path.join(run.evidence, "stage-b-evidence.json");
  requireThat(
    !fs.existsSync(progress) && !fs.existsSync(packet),
    "SCENARIO_ALREADY_ATTEMPTED",
  );
  const trail = emptyTrail();
  const failures: string[] = [];
  const fail = (error: unknown) => {
    const code = error instanceof Error ? error.message : "";
    failures.push(
      signal?.aborted
        ? "SCENARIO_ABORTED"
        : /^SCENARIO_[A-Z_]+$/.test(code)
          ? code
          : "SCENARIO_HOST_FAILURE",
    );
  };
  let stopped = false;
  let active: Run | undefined;
  let proof: ReturnType<typeof auditStageRun> | undefined;
  try {
    checkAbort(signal);
    writeJSON(progress, trail);
    setFutureInputs(domains.root, run.lineage, visibleInputs(timelineSteps));
    checkAbort(signal);
    active = await domains.start(run.id);
    await playStageScenario(
      run.config.case_id,
      timelineSteps,
      secretaryHost(domains, active),
      trail,
      signal,
    );
  } catch (e) {
    fail(e);
  } finally {
    // Cleanup is required even when campaign admission has been revoked.
    try {
      await domains.stop(run.id);
      stopped = true;
    } catch {
      failures.push("SCENARIO_STOP_UNCONFIRMED");
    }
  }
  if (active && stopped) {
    try {
      proof = auditStageRun(domains.root, domains.load(run.id), trail);
      failures.push(...proof.requirements);
    } catch (e) {
      fail(e);
    }
  }
  const selected = path.join(run.evidence, "stage-b-semantic-evidence.json");
  writeJSON(selected, {
    schema: "issue122-stage-excerpts-v1",
    excerpts: proof?.excerpts ?? [],
  });
  writeJSON(packet, {
    excerpts_sha256: sha(read(selected)),
    schema: "issue122-stage-scenario-evidence-v2",
    episode: run.lineage,
    lane: run.config.lane,
    freeze_sha256: run.config.freeze_sha256,
    timeline_sha256: sha(JSON.stringify(timelineSteps)),
    trail,
    proof,
    failures,
    semantic: "UNRESOLVED",
  });
  requireThat(stopped, "INFRASTRUCTURE");
  return {
    completed: !failures.length,
    ...(failures[0] ? { reason: failures[0] } : {}),
    evidence: sha(read(packet)),
  };
}
