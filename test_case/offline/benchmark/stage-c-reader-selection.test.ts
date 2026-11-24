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
