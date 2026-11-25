import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkTargetedSpend,
  checkTargetedSend,
  closeTargetedAccount,
  holdTargetedAccount,
  targetedClaim,
} from "../../online/benchmark/stage-c-targeted-account.ts";
import { targetedWorkload } from "../../online/benchmark/stage-c-targeted-policy.ts";
import { writeJSON, readJSON } from "../../online/benchmark/io.ts";
const freeze = "a".repeat(64);
function fixture(t: { after: (fn: () => void) => void }) {
  const a = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "targeted-account-"),
  );
  t.after(() => fs.rmSync(a, { force: true, recursive: true }));
  return a;
}
test("supplement charges the greater of local, campaign and Go list amounts, never crediting an uncertain settlement", (t) => {
  const account = fixture(t);
  const attempt = { id: "one", reserved_usd: 0.7 };
  const row = {
    attempt,
    charged_usd: 0.1,
    settled: true,
    usage: { go_meter: { list_cost: 0.6 } },
  };
  const ledger = { entries: new Map([["one", row]]) } as any;
  const r = path.join(account, "usage-reservations/one.json");
  assert.equal(checkTargetedSpend(account, freeze, ledger, 4.3), 0.7);
  assert.throws(
    () => checkTargetedSpend(account, freeze, ledger, 4.31),
    /SPEND_LIMIT/,
  );
  writeJSON(r, { amount: 0.2, settled: true, freeze });
  assert.equal(checkTargetedSpend(account, freeze, ledger, 4.4), 0.6);
  row.charged_usd = 0.8;
  assert.throws(
    () => checkTargetedSpend(account, freeze, ledger, 4.3),
    /SPEND_LIMIT/,
  );
  row.settled = false;
  assert.throws(
    () => checkTargetedSpend(account, freeze, ledger, 0.01),
    /OUTSTANDING/,
  );
  row.settled = true;
  writeJSON(r, { amount: 0.2, freeze: "other" });
  assert.throws(
    () => checkTargetedSpend(account, freeze, ledger, 0.01),
    /RESERVATION/,
  );
});
test("only the claimed freeze can stop its own facility and the legacy hold is immutable", (t) => {
  const a = fixture(t),
    root = path.join(a, "child"),
    old = path.join(a, "hold.json");
  writeJSON(old, { freeze: "parent", reason: "uncertain" });
  const file = path.join(a, targetedWorkload.series + ".json");
  writeJSON(file, { root, freeze, closed: false });
  assert.equal(holdTargetedAccount(a, "wrong", "budget"), false);
  assert.equal(holdTargetedAccount(a, freeze, "budget"), true);
  holdTargetedAccount(a, freeze, "later");
  assert.equal(
    readJSON(path.join(a, targetedWorkload.series + "-hold.json")).reason,
    "budget",
  );
  assert.throws(() => closeTargetedAccount(a, root, "wrong"), /BINDING/);
  closeTargetedAccount(a, root, freeze);
  assert.equal(targetedClaim(a)?.closed, true);
  assert.deepEqual(readJSON(old), { freeze: "parent", reason: "uncertain" });
});
test("an open workload lane must be one of the two approved names and belong to the child freeze", (t) => {
  const r = fixture(t),
    file = path.join(r, "campaign/active-stage-c.json");
  const a = {
    state: "OPEN",
    freeze_sha256: freeze,
    lane: "r1-C12b--deepseek-flash",
  };
  writeJSON(file, a);
  checkTargetedSend(r, freeze);
  for (const change of [
    { state: "CLOSED" },
    { freeze_sha256: "parent" },
    { lane: "r1-C06-resident-B--deepseek-flash" },
  ]) {
    writeJSON(file, { ...a, ...change });
    assert.throws(() => checkTargetedSend(r, freeze), /LANE/);
  }
});

test("an incomplete Go response or unconfirmed subscription billing stops the supplement", async () => {
  const { goResponseMeter, targetedBillingHold } =
    await import("../../online/benchmark/stage-c-go-provider.ts");
  const meter = goResponseMeter();
  assert.equal(
    targetedBillingHold(meter.receipt, true),
    "GO_UNCONFIRMED_SUBSCRIPTION_BILLING",
  );
  meter.observe({
    usage: { cost: 0, opencode: { billing_source: "go", list_cost: 0.004 } },
  });
  assert.equal(targetedBillingHold(meter.receipt, true), null);
  assert.equal(
    targetedBillingHold(meter.receipt, false),
    "GO_TARGETED_TRANSPORT_UNCERTAIN",
  );
  meter.observe({ usage: { cost: 0.01 } });
  assert.equal(
    targetedBillingHold(meter.receipt, true),
    "GO_UNCONFIRMED_SUBSCRIPTION_BILLING",
  );
});
