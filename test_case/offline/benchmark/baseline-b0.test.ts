import assert from "node:assert/strict";
import test from "node:test";
import { b0Matrix, fillerPlan } from "../../online/benchmark/baseline-b0.ts";
import { baselineCases } from "../../online/benchmark/baseline-scenarios.ts";
import {
  lintTimeline,
  timeline,
} from "../../online/benchmark/baseline-timeline.ts";
import { baselineModels } from "../../online/benchmark/live-model.ts";

const rows = baselineModels.flatMap((model) =>
  ["DEP", "RC98304_CANDIDATE"].map((profile) => ({
    profile,
    model,
    budget: {
      estimated_tokens: 19000,
      usable_input_tokens: profile === "DEP" ? 989308 : 85196,
    },
    window: { count: profile === "DEP" ? 12 : 2 },
    recent_input_byte_allowance: profile === "DEP" ? 148396 : 4259,
    effective_policy: { normal: 0.6 },
  })),
) as Parameters<typeof b0Matrix>[0];

test("B0 retains all ordered slots, protects required Flash and never claims a measured exit", () => {
  const slots = b0Matrix(rows);
  assert.equal(slots.length, 12);
  assert.deepEqual(
    slots.slice(0, 3).map((slot) => slot.model),
    ["deepseek-flash", "gpt-6.2-sol", "gpt-6-luna"],
  );
  assert.equal(
    slots.filter((slot) => slot.required && !slot.quota_skip_allowed).length,
    4,
  );
  assert(
    slots.every((slot) =>
      slot.profiles.every(
        (profile) => !profile.live_dispatch && !profile.measured_exit,
      ),
    ),
  );
  assert.throws(
    () => b0Matrix([...rows.slice(0, 5), rows[0]]),
    /INCOMPLETE_COHORT/,
  );
  const cold = slots.at(-1)!.profiles;
  assert.notEqual(cold[0].recipe!.bytes_each, cold[1].recipe!.bytes_each);
  for (const cell of cold) {
    assert(
      cell.recipe!.bytes_each * cell.capacity.window.count <
        cell.capacity.recent_input_byte_allowance,
    );
    assert(cell.recipe!.bytes_each < cell.recipe!.headroom);
  }
  assert.equal(
    fillerPlan({ ...rows[0], recent_input_byte_allowance: 1 }, true),
    null,
  );
});

test("B0 M5 controls use distinct creation and withdrawal routes; leak lint catches tokens and plurals", () => {
  const get = (id: string) =>
    timeline(baselineCases(true).find((row) => row.id === id)!);
  for (const id of [
    "C10-model-created",
    "C10-discussed",
    "C11-autonomous-invalidation",
  ])
    lintTimeline(get(id));
  assert(
    !get("C10-model-created").some((step) => step.action === "MASTER_TASK"),
  );
  assert(
    !get("C10-discussed").some(
      (step) =>
        step.action === "SCRIPTED_FILE" || step.action === "MASTER_TASK",
    ),
  );
  assert(
    !get("C11-autonomous-invalidation").some(
      (step) => step.action === "MASTER_CANCEL",
    ),
  );
  assert(
    get("C11-invalidated").some((step) => step.action === "MASTER_CANCEL"),
  );
  for (const text of ["BENCHMARK_NOTE_READ", "faults", "drivers", "oracles"])
    assert.throws(
      () => lintTimeline([{ action: "MASTER_MESSAGE", text }]),
      /INPUT_LEAK/,
    );
});
