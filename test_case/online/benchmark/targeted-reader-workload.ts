import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { noLinks, read, requireThat, sha } from "./io.ts";
import { countRecoveryWrites } from "./stage-c-recovery.ts";
export const workloadLanes = {
  "c16-repeat1": "r1-C16-combined--deepseek-flash",
  c12b: "r1-C12b--deepseek-flash",
} as const;
export type WorkloadRoute = keyof typeof workloadLanes;
const digest = (v: unknown) =>
  typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
function exact(file: string) {
  noLinks(file);
  return read(file);
}
const fileJSON = (file: string) => JSON.parse(exact(file).toString());
export function checkWorkloadClosure(
  facility: string,
  freezeSha: string,
  dispatchSha?: string,
) {
  noLinks(facility);
  const frozenBytes = exact(path.join(facility, "configs/stage-c-freeze.json")),
    stateBytes = exact(path.join(facility, "campaign/stage-c-dispatch.json"));
  const frozen = JSON.parse(frozenBytes.toString()),
    state = JSON.parse(stateBytes.toString()),
    lanes = Object.values(workloadLanes).sort();
  requireThat(
    sha(frozenBytes) === freezeSha &&
      (!dispatchSha || sha(stateBytes) === dispatchSha) &&
      frozen.targeted_supplement?.series === "issue122-r67-evidence-v1" &&
      Array.isArray(frozen.batch) &&
      frozen.batch.every((r: any) => r.targeted_supplement === true) &&
      isDeepStrictEqual(
        frozen.batch.map((r: any) => r.lane.lane).sort(),
        lanes,
      ) &&
      state.freeze_sha256 === freezeSha &&
      state.ended === true &&
      state.current === null &&
      isDeepStrictEqual(Object.keys(state.terminals).sort(), lanes) &&
      Object.values(state.terminals).every((v: any) =>
        ["COMPLETED", "INCOMPLETE", "UNRUN"].includes(v?.status),
      ),
    "TARGETED_WORKLOAD_CLOSURE",
  );
  return { state, freeze_sha256: freezeSha, dispatch_sha256: sha(stateBytes) };
}
export function targetWorkloadSource(
  facility: string,
  closure: ReturnType<typeof checkWorkloadClosure>,
  route: WorkloadRoute,
  captureFile?: string,
) {
  const lane = workloadLanes[route],
    terminal = closure.state.terminals[lane],
    run = terminal.run;
  requireThat(
    terminal.status !== "UNRUN" &&
      typeof run === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        run,
      ) &&
      digest(terminal.report_sha256),
    "TARGETED_NO_WORKLOAD_REPORT",
  );
  const dir = path.join(facility, "evidence", run),
    raw = exact(path.join(dir, "stage-c-trial.json")),
    trial = JSON.parse(raw.toString());
  requireThat(
    sha(raw) === terminal.report_sha256 &&
      trial.run === run &&
      trial.descriptor?.scenario ===
        (route === "c16-repeat1" ? "C16-combined" : "C12b") &&
      Array.isArray(trial.observations),
    "TARGETED_WORKLOAD_REPORT",
  );
  const original = trial.observations.filter(
    (o: any) => o.physical && o.run === run,
  );
  requireThat(original.length === 1, "TARGETED_PHYSICAL_RUN");
  const proof = {
    freeze_sha256: closure.freeze_sha256,
    dispatch_sha256: closure.dispatch_sha256,
    terminal: terminal.status,
    run,
    lane,
    trial_sha256: sha(raw),
  };
  if (route === "c16-repeat1") {
    const expected = path.join(dir, "stage-c-targeted-capture.json");
    requireThat(
      captureFile === undefined || captureFile === expected,
      "TARGETED_FOREIGN_CAPTURE_PATH",
    );
    const recorded = original[0].targeted_capture;
    requireThat(
      recorded?.status === "CAPTURED" && digest(recorded.sha256),
      "TARGETED_NO_CAPTURE",
    );
    const data = exact(expected);
    requireThat(sha(data) === recorded.sha256, "TARGETED_CAPTURE_FILE_SHA");
    return {
      proof: { ...proof, capture_file_sha256: sha(data) },
      capture: JSON.parse(data.toString()),
    };
  }
  const r = trial.observations.filter((o: any) => o.host_assisted === true);
  requireThat(r.length === 1, "TARGETED_NO_RECOVERY");
  const obs = r[0];
  const load = (name: string) => exact(path.join(dir, name));
  const members = [
    "stage-c-recovery-receipt.json",
    "stage-c-barrier.json",
    "stage-c-write-attempts.jsonl",
    "stage-c-physical-writes.jsonl",
  ];
  const files = members.map(load),
    parse = (i: number) => JSON.parse(files[i].toString()),
    lines = (i: number) =>
      files[i]
        .toString()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((x) => JSON.parse(x));
  const receipt = parse(0),
    barrier = parse(1),
    attempts = lines(2),
    writes = lines(3);
  requireThat(
    isDeepStrictEqual(receipt.result, obs) &&
      isDeepStrictEqual(barrier, receipt.bound) &&
      barrier.run === run &&
      barrier.operation === obs.operation &&
      obs.kind === "DIRECT_SAME_DOMAIN" &&
      receipt.restart?.kind === obs.kind &&
      receipt.restart.old_exit?.sha256 === obs.old_exit &&
      receipt.restart.new_start?.sha256 === obs.new_start &&
      [
        obs.old_exit,
        obs.new_start,
        obs.pre_restart_journal,
        obs.unknown_journal,
        obs.final_journal,
      ].every(digest) &&
      receipt.verify?.request_id === obs.verify_request &&
      receipt.verify.acceptance === "ACCEPTED" &&
      sha(JSON.stringify(receipt.verify)) === obs.verify_receipt_sha256 &&
      attempts.length > 0 &&
      writes.length === obs.physical_writes &&
      typeof obs.reconciled === "boolean",
    "TARGETED_RECOVERY_BOUNDARY",
  );
  const count = countRecoveryWrites(attempts, writes, barrier, !obs.reconciled),
    effective =
      count === "PASS" && obs.content_sha256 !== barrier.expected_hash
        ? "UNRESOLVED"
        : count;
  requireThat(
    effective === obs.effects ||
      (effective === "PASS" && obs.effects === "UNRESOLVED"),
    "TARGETED_RECOVERY_COUNT",
  );
  return {
    proof: {
      ...proof,
      recovery_file_sha256: Object.fromEntries(
        members.map((n, i) => [n, sha(files[i])]),
      ),
      mechanical_effects: obs.effects,
    },
    observation: {
      recorded_attempts: attempts.length,
      observed_writes: writes.length,
      direct_same_domain_restart: true,
      unknown_observed: true,
      verify_accepted: true,
      reconciled: obs.reconciled,
      final_content_matches: obs.content_sha256 === barrier.expected_hash,
    },
  };
}
