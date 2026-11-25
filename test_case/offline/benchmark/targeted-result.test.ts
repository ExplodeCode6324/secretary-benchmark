import assert from "node:assert/strict";
import test from "node:test";
import { agreedAssertions } from "../../online/benchmark/targeted-workload-result.ts";
test("both independently reconstructed receipt views must agree before assertions enter the supplement", () => {
  const mark = {
    status: "ACCEPTED",
    visibility: "COLD",
    assertions: [{ assertion: "use_current", verdict: "PASS" }],
  };
  const good = {
    accepted: true,
    official: mark,
    supplemental: structuredClone(mark),
  } as any;
  assert.deepEqual(agreedAssertions(good), { use_current: "PASS" });
  good.supplemental.assertions[0].verdict = "FAIL";
  assert.throws(() => agreedAssertions(good), /RECEIPTS_DISAGREE/);
  good.accepted = false;
  assert.equal(agreedAssertions(good), null);
});
