import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { combineResults } from "../../online/benchmark/stage-c-combine.ts";
import {
  flashRule,
  projectCampaign,
} from "../../online/benchmark/stage-c-freeze.ts";
import {
  stageCases,
  caseDefinition,
  sutCommit,
  piCommit,
} from "../../online/benchmark/stage-c-plan.ts";
import { sha } from "../../online/benchmark/io.ts";

test("combined reports keep the denominator, reject overlapping lineages and bind both paired branches", () => {
  const dir = new URL("./fixtures/stage-c/", import.meta.url);
  const inputs = JSON.parse(
    fs.readFileSync(new URL("rehearsal-inputs.json", dir), "utf8"),
  );
  delete inputs.evidence_class;
  for (const c of stageCases())
    inputs.samples[c.id] = inputs.samples["C04-resident"];
  inputs.calibration = {
    reader: "fixture",
    version: "v",
    rubric_sha256: sha("r"),
    packet_sha256: sha("p"),
    key_sha256: sha("k"),
    max_attempts: 3,
  };
  const projection = projectCampaign(inputs, {
    "deepseek-flash": flashRule(
      fs.readFileSync(new URL("rehearsal-rates.md", dir)),
      "2026-11-24T00:00:00Z",
    ),
  });
  const snapshots = projection.batches.map((batch, i) => {
    const hash = sha("synthetic freeze " + i);
    const rows = batch.flatMap((r) => {
      const c = caseDefinition(r.lane.scenario),
        branches = c.pair
          ? stageCases().filter((x) => x.pair?.id === c.pair!.id)
          : [c];
      return branches.map((v) => ({
        source_lineage: r.lane.lane,
        scenario: v.id,
        model: r.lane.model,
        repeat: r.lane.repeat,
        profile: r.lane.profile,
        external_recipe_sha256:
          v.pair?.position === "B" ? r.pair : r.trial.timeline,
        status: "INCOMPLETE",
        identities: [],
        assessment_attempts: 0,
      }));
    });
    return {
      hash,
      projection,
      freeze: {
        evidence_class: "LIVE",
        source: {
          head: "fixture",
          sut: {
            commit: sutCommit,
            submodules: { "src/pi_resource": piCommit },
          },
        },
        batch_index: i + 1,
        batch,
        projection_sha256: sha(JSON.stringify(projection)),
      },
      result: {
        evidence_class: "LIVE",
        batch_closed: true,
        freeze_sha256: hash,
        rows,
        physical_sends: 1,
        known_usd: 1,
        unresolved_cost_reservation_usd: 0,
      },
      decisions: { workload: "synthetic decision " + i },
    };
  });
  const partial = combineResults([snapshots[0]]);
  assert.deepEqual(partial.dispositions, {
    COMPLETED: 0,
    INCOMPLETE: 1,
    UNRUN: 98,
  });
  assert.throws(
    () => combineResults([snapshots[0], snapshots[0]]),
    /AGGREGATE_ROW/,
  );
  const all = combineResults(snapshots.toReversed());
  assert.equal(all.reported_observations, 99);
  const changed = structuredClone(snapshots);
  changed.at(-1)!.result.rows[0].external_recipe_sha256 = sha("changed");
  assert.throws(() => combineResults(changed), /AGGREGATE_ROW/);
});
