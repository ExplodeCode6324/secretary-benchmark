import assert from "node:assert/strict";
import test from "node:test";
import {
  delivery,
  nativeDelivery,
  deliveryRequest,
  nativeWriteRecipe,
} from "../../online/benchmark/stage-c-fault.ts";
import { describeTrial } from "../../online/benchmark/stage-c-plan.ts";

test("C12b native-write supplement binds a distinct task, recipe and external input", () => {
  const original = describeTrial(
    "C12b",
    1,
    "deepseek-flash",
    "OFFLINE_FIXTURE",
  );
  const supplement = describeTrial(
    "C12b",
    1,
    "deepseek-flash",
    "OFFLINE_FIXTURE",
    undefined,
    nativeWriteRecipe,
  );
  assert.equal(supplement.seed, original.seed);
  assert.notEqual(supplement.recipe_sha256, original.recipe_sha256);
  assert.notEqual(
    supplement.external_inputs_sha256,
    original.external_inputs_sha256,
  );
  assert.equal(
    original.steps.find((s) => s.action === "MASTER_TASK")?.payload?.goal,
    delivery.goal,
  );
  assert.equal(
    supplement.steps.find((s) => s.action === "MASTER_TASK")?.payload?.goal,
    nativeDelivery.goal,
  );
  assert.notEqual(
    deliveryRequest("one-run"),
    deliveryRequest("one-run", nativeWriteRecipe),
  );
  assert.throws(
    () =>
      describeTrial(
        "C16-combined",
        1,
        "deepseek-flash",
        "OFFLINE_FIXTURE",
        undefined,
        nativeWriteRecipe,
      ),
    /C12B_UNKNOWN_RECIPE/,
  );
});
