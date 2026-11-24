import path from "node:path";
import { read, readJSON, requireThat, sha } from "./io.ts";
import { type FrozenBatch } from "./stage-c-freeze.ts";

import {
  caseDefinition,
  stageCases,
  sutCommit,
  piCommit,
} from "./stage-c-plan.ts";

export const archivedC04 = "r1-C04-resident--deepseek-flash";
export const c04Freeze =
  "8de5098616b39e9dd33cebf50131a9b1456b42f87075ccbbebfff9526b428bab";
export const firstC16 =
  "ddbee6ee0ba483ef7f4ce39f06f44bc890316ebf6732f975f6a0a5d2fcc9e0ff";
export const c04Trial =
  "d6808110c5159f180dd09d3163263ba960072275c5374eabc6f43003cc156f06";
export type RemainingSeries = {
  decision_sha256: string;
  matrix_sha256: string;
  previous_c16: string;
  original_c04: string;
  partition: number;
  allocations: ReturnType<typeof allocationTable>;
  recovery_series: "c16-recovery-1";
  recovery_inventory: string[];
};
// Bind each partition's lanes and both budgets before the first paid reservation.
export function allocationTable(batches: FrozenBatch[]) {
  return batches.slice(1).map((batch, i) => {
    const candidates = batch.reduce(
      (sum, r) => sum + (r.pair ? 2 : 1),
      i === 0 ? 1 : 0,
    );
    return {
      partition: i + 2,
      lanes: batch.map((r) => ({
        lane: r.lane.lane,
        cap: r.lane.cap,
        seconds: r.lane.seconds,
      })),
      physical_calls: batch.reduce((sum, r) => sum + r.lane.cap, 0),
      seconds: batch.reduce((sum, r) => sum + r.lane.seconds, 0),
      workload_usd: Number(
        batch.reduce((sum, r) => sum + r.forecast.worst_usd, 0).toFixed(9),
      ),
      calibrations: 1,
      candidates,
      reader_usd: (688128 + candidates * 2162688) / 1e7,
    };
  });
}
export function validateSeries(
  s: RemainingSeries,
  index: number,
  batches: FrozenBatch[],
) {
  const caps = [1827, 2223, 1504, 2213, 1781, 1072],
    sizes = [3, 3, 2, 27, 28, 29];
  const rest = batches.slice(1),
    rows = rest.flat();
  const allocations = allocationTable(batches);
  const candidateCaps = [4, 3, 4, 31, 28, 29],
    laneSeconds = [36270, 43047, 29200, 42109, 42904, 24476];
  requireThat(
    allocations.length === 6 &&
      JSON.stringify(allocations) === JSON.stringify(s.allocations) &&
      allocations.every(
        (a, i) =>
          a.physical_calls === caps[i] &&
          a.seconds <= laneSeconds[i] &&
          a.candidates === candidateCaps[i] &&
          a.workload_usd <= caps[i] * 0.7718592 + 1e-9,
      ),
    "STAGE_C_SERIES_ALLOCATION",
  );
  const definitions = stageCases();
  const inventory = batches
    .flat()
    .flatMap((r) => {
      const c = caseDefinition(r.lane.scenario);
      return (
        c.pair ? definitions.filter((d) => d.pair?.id === c.pair!.id) : [c]
      ).map((d) => ({
        lane: r.lane.lane,
        case_id: d.id,
        model: r.lane.model,
        repeat: r.lane.repeat,
        seed: r.lane.seed,
        profile: r.lane.profile,
        recipe_sha256: d.pair?.position === "B" ? r.pair : r.trial.timeline,
        sut: sutCommit,
        pi: piCommit,
      }));
    })
    .sort(
      (a, b) =>
        a.lane.localeCompare(b.lane) || a.case_id.localeCompare(b.case_id),
    );
  requireThat(
    sha(JSON.stringify(inventory)) === s.matrix_sha256,
    "STAGE_C_SERIES_INVENTORY",
  );
  requireThat(
    s.decision_sha256 ===
      "eeddd9527a8ce683414c765ba17e841e085b7e60d3d364a19b5a407cdf35dbb3" &&
      s.matrix_sha256 ===
        "fe6cebd4fdeca7e00cc95134bf778e6f8fbe54190778f2750c039620a83f65ee" &&
      s.recovery_series === "c16-recovery-1" &&
      JSON.stringify(s.recovery_inventory) ===
        JSON.stringify(
          rest[0]?.map((r) => s.recovery_series + "/" + r.lane.lane),
        ) &&
      s.previous_c16 === firstC16 &&
      s.original_c04 === c04Freeze &&
      index === s.partition &&
      Number.isInteger(index) &&
      index >= 2 &&
      index <= 7 &&
      rest.length === 6 &&
      rest.every(
        (b, i) =>
          b.length === sizes[i] &&
          b.reduce((sum, r) => sum + r.lane.cap, 0) <= caps[i] &&
          b.reduce((sum, r) => sum + r.lane.seconds, 0) <= 43200,
      ) &&
      rows.every(
        (r) => r.lane.model === "deepseek-flash" && r.lane.lane !== archivedC04,
      ) &&
      new Set(rows.map((r) => r.lane.lane)).size === 92 &&
      rows.reduce((sum, r) => sum + r.forecast.worst_usd, 0) <=
        8197.144704 + 1e-8,
    "STAGE_C_REMAINING_AUTHORIZATION",
  );
}
// These three immutable members cover every byte consumed by trialPacket for the archived control.
export function originalC04Input(root: string) {
  const dir = path.join(root, "inputs/archived-c04"),
    stateFile = path.join(dir, "campaign/stage-c-dispatch.json");
  requireThat(
    sha(read(stateFile)) ===
      "5803ff51c70dc2832e03886c30e28a0509400d3d7296445108fe6391eb14acaf",
    "STAGE_C_ARCHIVED_C04_STATE",
  );
  const t = readJSON(stateFile).terminals[archivedC04],
    file = path.join(dir, "evidence", t.run, "stage-c-trial.json");
  requireThat(
    t.report_sha256 === c04Trial && sha(read(file)) === c04Trial,
    "STAGE_C_ARCHIVED_C04_TRIAL",
  );
  const o = readJSON(file).observations.find((v: any) => v.physical);
  requireThat(
    sha(
      read(
        path.join(
          dir,
          "evidence",
          o.run,
          "send-" + o.physical.outcome.probe_send + ".json",
        ),
      ),
    ) === "7ede9fe1405521ad810d30e6ac4e46586973a0c1ec67929498644104d30fa807",
    "STAGE_C_ARCHIVED_C04_WIRE",
  );
  return dir;
}
