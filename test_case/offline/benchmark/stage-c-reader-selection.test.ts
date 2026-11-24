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

import {
  visibilityV2,
  officialReader,
  newVisibilityControls,
  renderReaderQuery,
  readerPolicy,
  readerResponse,
} from "../../online/benchmark/stage-c-visibility-rubric.ts";
test("prospective visibility controls bind complete and incomplete capture and verify the raw native reply", () => {
  const c = newVisibilityControls(),
    packet = {
      rubric: scoringRubric(officialReader, visibilityV2),
      controls: c.reader,
    };
  assert.deepEqual(
    new Set(c.key.map((r) => r.expected)),
    new Set(["COLD", "OPAQUE", "RESIDENT"]),
  );
  assert(c.reader.every((r) => JSON.parse(r.text).surfaces.length === 4));
  const q = renderReaderQuery(packet);
  assert.equal(q.includes('"expected":'), false);
  const raw = '{"labels":[]}',
    freeze = sha("freeze");
  const t = {
    ...readerPolicy,
    native_entry: "AIAgent.run_conversation",
    max_tokens: 49152,
    wire_bytes: Buffer.byteLength(q) + 600,
    wire_sha256: sha("wire"),
    decision_sha256: freeze,
    input_sha256: sha(q),
    raw_sha256: sha(raw),
    returned_model: "deepseek-flash",
    fallback: false,
    tools: 0,
    inference_dispatches: 1,
    http_status: 200,
    finish_reason: "stop",
    usage: {
      prompt_tokens: 10,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 10,
      completion_tokens: 10,
    },
    created: "2026-11-24T16:00:00Z",
    finished: "2026-11-24T16:00:02Z",
    calculated_charge_usd: 0.0000075,
  };
  const rate = { input_rate: 0.3, output_rate: 1.2, cache_input_rate: 0.006 };
  const evidence = {
    dispatch: { decision_sha256: freeze, wire_sha256: t.wire_sha256 },
    transport: t,
    raw,
  };
  assert.deepEqual(readerResponse(evidence, packet, freeze, rate), {
    labels: [],
  });
  for (const patch of [
    { input_sha256: sha("wrong") },
    { returned_model: "other" },
    { fallback: true },
    { max_tokens: 16384 },
    { calculated_charge_usd: 0 },
  ]) {
    assert.throws(
      () =>
        readerResponse(
          { ...evidence, transport: { ...t, ...patch } },
          packet,
          freeze,
          rate,
        ),
      /STAGE_C_READER/,
    );
  }
  assert.throws(
    () => readerResponse({ ...evidence, raw: "changed" }, packet, freeze, rate),
    /STAGE_C_READER/,
  );
});
