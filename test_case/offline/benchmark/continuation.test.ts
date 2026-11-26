import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendJSON, writeJSON } from "../../online/benchmark/io.ts";
import {
  boundModelBlock,
  resumableLaneFailure,
  retryTime,
  providerRetryAt,
} from "../../online/benchmark/stage-c-continuation.ts";
import type { Run } from "../../online/benchmark/domain.ts";

test("only the failed call and matching context authorize a product resume", (t) => {
  const root = mkdtempSync(
    path.join(realpathSync(os.tmpdir()), "continuation-block-"),
  );
  t.after(() => rmSync(root, { recursive: true }));
  const run = { id: "run", evidence: path.join(root, "evidence") } as Run;
  const session = {
    id: "session",
    state: "RECOVERY_BLOCKED",
    model_blocked_call: "call",
  };
  const observed = {
    session_id: "session",
    sessions: [session],
    calls: [
      {
        id: "call",
        state: "FAILED",
        scope: { session_id: "session" },
        request: { sha256: "context" },
      },
    ],
  };
  const observation = path.join(run.evidence, "observed.json");
  writeJSON(observation, observed);
  mkdirSync(path.join(root, "campaign"));
  const refusal = path.join(root, "campaign", "facility-refusals.jsonl");
  appendJSON(refusal, {
    run: "run",
    model_call: "earlier",
    context_sha256: "context",
    reason: "HTTP_503",
  });
  assert.equal(boundModelBlock(root, run), undefined);
  assert.equal(resumableLaneFailure("SCENARIO_PRODUCT_BLOCKED", false), false);
  appendJSON(refusal, {
    run: "run",
    model_call: "call",
    context_sha256: "context",
    reason: "GO_REQUEST_WINDOW_EXHAUSTED",
  });
  assert.equal(boundModelBlock(root, run)?.call.id, "call");
  assert.equal(resumableLaneFailure("SCENARIO_PRODUCT_BLOCKED", true), true);
  for (const reason of [
    "C12B_FINISHED_WITHOUT_WRITE",
    "C12B_PREFAULT_CONTENT_MISMATCH",
    "CAPACITY_BLOCKED",
  ])
    assert.equal(resumableLaneFailure(reason, true), false);
  session.state = "CAPACITY_BLOCKED";
  writeJSON(observation, observed);
  assert.equal(boundModelBlock(root, run), undefined);
  assert.equal(resumableLaneFailure("ENOSPC: disk full", false), true);
  const backoff = path.join(root, "campaign", "provider-backoff.jsonl");
  appendJSON(backoff, { retry_at: retryTime("60", 1000) });
  appendJSON(backoff, { retry_at: retryTime("1", 2000) });
  assert.equal(providerRetryAt(root), 61000);
});

import { blindHistory } from "../../online/benchmark/targeted-result.ts";

test("a received reader result closes the position and only an expired passed calibration may refresh", () => {
  const graded = {
    id: "first",
    state: "GRADED",
    started: 0,
    calibrationTime: 500,
  };
  const failed = { ...graded, state: "READER_RECEIPT_REJECTED" };
  const retry = {
    id: "next",
    state: "GRADED",
    started: 86400500,
    previousCalibration: "first",
  };
  assert.throws(
    () => blindHistory("calibration", [failed, retry]),
    /REPEAT_AFTER_RECEIPT/,
  );
  assert.throws(
    () => blindHistory("c16-repeat1", [graded, retry]),
    /DUPLICATE_GRADE/,
  );
  assert.throws(
    () =>
      blindHistory("calibration", [graded, { ...retry, started: 86400499 }]),
    /DUPLICATE_GRADE/,
  );
  assert.throws(
    () =>
      blindHistory("c12b", [
        { ...failed, state: "PENDING_RECONCILIATION" },
        retry,
      ]),
    /REPEAT_AFTER_RECEIPT/,
  );
  assert.equal(blindHistory("calibration", [graded, retry]).passed?.id, "next");
  assert.equal(
    blindHistory("c12b", [{ ...failed, state: "RECONCILED_NO_GRADE" }, retry])
      .passed?.id,
    "next",
  );
});
