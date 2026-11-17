import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import { repository, sha } from "../../online/benchmark/io.ts";
import { differentialFixture } from "./differential-fixture.ts";

test("split preserves exact judge requests, controls and selected report semantics", async () => {
  const ids = Object.fromEntries(
    ["id", "run", "nonce", "packet", "cohort"].map((k) => [
      k,
      crypto.randomUUID(),
    ]),
  );
  const old = await differentialFixture(
    path.join(repository, "sut/secretary"),
    ids,
  );
  const current = await differentialFixture(repository, ids);
  assert.equal(current.request, old.request);
  assert.deepEqual(current.batch, old.batch);
  assert.deepEqual(current.report, current.replayAgain);
  assert.deepEqual(old.report, old.replayAgain);
  const semantic = ({ code_head, replay_input_sha256, ...body }: any) => body;
  assert.deepEqual(semantic(current.report), semantic(old.report));
});

test("public QA Opus variant packet is byte-identical to the pinned baseline", async () => {
  const run = crypto.randomUUID(),
    nonce = crypto.randomUUID(),
    packetID = crypto.randomUUID();
  const fixtureID = crypto.randomUUID();
  const packetBytes: Buffer[] = [];
  for (const base of [path.join(repository, "sut/secretary"), repository]) {
    const load = (name: string) =>
      import(
        pathToFileURL(
          path.join(base, "test_case/online/benchmark", name + ".ts"),
        ).href
      );
    const { writeJSON, lease } = await load("io");
    const { exportPublicGrades } = await load("public-grading");
    const root = path.join(
        base,
        ".local/benchmark",
        "public-differential-" + fixtureID,
      ),
      evidence = path.join(root, "evidence", run),
      dir = path.join(root, "oracles/longmemeval");
    writeJSON(path.join(root, "facility.json"), {
      version: 1,
      repository: base,
      nonce,
    });
    const record = { id: run, state: "STOPPED", evidence };
    writeJSON(path.join(root, "runs", run + ".json"), record);
    const input = { id: "fixture-question", sessions: [] };
    writeJSON(path.join(root, "inputs/longmemeval-dev.json"), [input]);
    writeJSON(path.join(dir, "dev-gold.json"), [
      {
        id: input.id,
        question_id: input.id,
        question_type: "single-session-user",
        question: "Which city did I name?",
        answer: "Paris",
        session_map: [],
        answer_session_ids: [],
      },
    ]);
    writeJSON(path.join(dir, "manifest.json"), {
      inputs_sha256: {
        dev: sha(
          fs.readFileSync(path.join(root, "inputs/longmemeval-dev.json")),
        ),
      },
      gold_sha256: {
        dev: sha(fs.readFileSync(path.join(dir, "dev-gold.json"))),
      },
    });
    fs.copyFileSync(
      path.join(
        repository,
        "test_case/offline/benchmark/fixtures/evaluate_qa.py",
      ),
      path.join(dir, "evaluate_qa.py"),
    );
    writeJSON(path.join(evidence, "public-run.json"), {
      run_id: run,
      split: "dev",
      question_id: input.id,
      manifest_sha256: sha(fs.readFileSync(path.join(dir, "manifest.json"))),
      input_sha256: sha(JSON.stringify(input)),
      model: "fixture",
      version: "fixture",
    });
    writeJSON(path.join(evidence, "public-output.json"), { answer: "Paris" });
    // Fix only UUID allocation for the two fixture exports. Production code is unchanged.
    const randomUUID = crypto.randomUUID;
    try {
      crypto.randomUUID = (() => packetID) as typeof crypto.randomUUID;
      syncBuiltinESMExports();
      await lease(root, async (controller: any) =>
        exportPublicGrades({
          root,
          load: () => record,
          assertControllerLease: () => controller,
        }),
      );
    } finally {
      crypto.randomUUID = randomUUID;
      syncBuiltinESMExports();
    }
    packetBytes.push(
      fs.readFileSync(path.join(root, "oracles/public-qa-sealed-opus-v1.json")),
    );
  }
  assert.deepEqual(packetBytes[0], packetBytes[1]);
});
