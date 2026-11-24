import { execFileSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { repository } from "../../online/benchmark/io.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  hermesReaders,
  scoringRubric,
  matchesReader,
} from "../../online/benchmark/stage-c-grading.ts";
import { sha } from "../../online/benchmark/io.ts";

test("reader choice binds the same scoring rubric to one exact model, route and effort", () => {
  const old = scoringRubric("Opus 5.5 Extra");
  for (const [reader, identity] of Object.entries(hermesReaders)) {
    assert.deepEqual(scoringRubric(reader), { ...old, reader });
    const digest = sha("sealed packet"),
      receipt = {
        judge: { ...identity, reasoning_effort: "max" },
        packet_sha256: digest,
      };
    assert.equal(matchesReader(receipt, digest, reader), true);
    assert.equal(matchesReader(receipt, sha("another packet"), reader), false);
    for (const other of Object.keys(hermesReaders).filter((r) => r !== reader))
      assert.equal(matchesReader(receipt, digest, other), false);
    assert.equal(
      matchesReader(
        { ...receipt, judge: { ...receipt.judge, reasoning_effort: "high" } },
        digest,
        reader,
      ),
      false,
    );
    assert.equal(matchesReader(receipt, digest, "Opus 5.5 Extra"), false);
  }
  assert.throws(() => scoringRubric("DeepSeek"), /UNKNOWN_READER/);
});

test("the normal controls CLI accepts an explicit reader and preserves its existing controls", () => {
  const root = path.join(
    repository,
    ".local/benchmark/tests",
    "reader-controls-" + randomUUID(),
  );
  const controls = (reader: string) =>
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "test_case/online/benchmark/cli.ts",
        "baseline-stage-c-controls",
        "--root",
        root,
        "--reader",
        reader,
      ],
      { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  const reader = "Hermes/deepseek/deepseek-flash/max",
    first = JSON.parse(controls(reader));
  assert.equal(first.reader, reader);
  assert.deepEqual(JSON.parse(controls(reader)), first);
  assert.throws(() => controls("Opus 5.5 Extra"), /STAGE_C_GRADER_CHANGED/);
});
