import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendJSON, sha, writeJSON } from "../../online/benchmark/io.ts";
import {
  boundModelBlock,
  requirePinnedIdentity,
  externalOutcome,
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

test("a cancelled native call can resume only within its own controller stop", (t) => {
  const root = mkdtempSync(
    path.join(realpathSync(os.tmpdir()), "controller-stop-"),
  );
  t.after(() => rmSync(root, { recursive: true }));
  const run = {
    id: "run",
    endpoint: { data_domain_id: "domain" },
    evidence: path.join(root, "evidence"),
  } as Run;
  const id = "e92d2b03-9d14-4369-ac39-7be91d459b4e";
  const at = Date.now();
  const call = {
    id,
    scope: { session_id: "session" },
    state: "INTERRUPTED",
    failure_kind: "CANCELLED",
    error: "Error: CORE_STOPPING",
    completed_at: new Date(at).toISOString(),
  };
  writeJSON(path.join(run.evidence, "observed.json"), {
    session_id: "session",
    sessions: [
      {
        id: "session",
        state: "RECOVERY_BLOCKED",
        recovery_error:
          "Error: MODEL_TRANSPORT_CANCELLED:" + id + ": Error: CORE_STOPPING",
      },
    ],
    calls: [call],
  });
  mkdirSync(path.join(root, "campaign"));
  const file = path.join(root, "campaign", "stage-c-controller-stops.jsonl");
  for (const stop of [
    { run: "other", domain: "domain", started: at, ended: at },
    { run: "run", domain: "other", started: at, ended: at },
    { run: "run", domain: "domain", started: at + 1, ended: at + 2 },
  ])
    appendJSON(file, stop);
  assert.equal(boundModelBlock(root, run), undefined);
  appendJSON(file, { run: "run", domain: "domain", started: at, ended: at });
  assert.equal(boundModelBlock(root, run)?.call.id, id);
});

test("an overlapping identity quarantine records a withheld matching response against its own call", (t) => {
  const root = mkdtempSync(
    path.join(realpathSync(os.tmpdir()), "delivery-fence-"),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = { id: "run", evidence: path.join(root, "evidence") } as Run;
  const campaign = path.join(root, "campaign");
  const active = path.join(campaign, "active-stage-c.json");
  writeJSON(active, { run: run.id, reviewed_identity_sequence: 0 });
  const at = new Date().toISOString();
  let previous = "0".repeat(64),
    sequence = 0;
  function event(value: object) {
    const hash = sha(JSON.stringify(value) + previous + ++sequence);
    appendJSON(path.join(campaign, "attempts.jsonl"), {
      event: value,
      previous,
      sequence,
      hash,
    });
    previous = hash;
  }
  for (const id of ["matching", "other"])
    event({
      type: "RESERVE",
      attempt: { id, run: run.id, at, reserved_usd: 0 },
    });
  const call = {
    id: "call",
    state: "FAILED",
    scope: { session_id: "session" },
    request: { sha256: "context" },
  };
  writeJSON(path.join(run.evidence, "send-matching.json"), {
    id: "matching",
    model_call: call.id,
    attribution: { context_sha256: "context" },
  });
  writeJSON(path.join(run.evidence, "observed.json"), {
    session_id: "session",
    sessions: [
      { id: "session", state: "RECOVERY_BLOCKED", model_blocked_call: call.id },
    ],
    calls: [call],
  });
  event({
    type: "SETTLE",
    id: "other",
    outcome: "VERSION_TRANSITION",
    actual_usd: null,
    at,
  });
  event({
    type: "SETTLE",
    id: "matching",
    outcome: "RESPONSE_COMPLETE",
    actual_usd: null,
    at,
    usage: { identity_status: "MATCH" },
  });
  assert.equal(boundModelBlock(root, run), undefined);
  assert.throws(
    () =>
      requirePinnedIdentity(root, run.id, () => ({
        model_call: call.id,
        context_sha256: "context",
        started: Date.now(),
        request_sha256: "wire",
        reservation_id: "matching",
      })),
    /GO_LANE_IDENTITY_PAUSED/,
  );
  assert.equal(boundModelBlock(root, run)?.call.id, call.id);
  writeJSON(active, { run: run.id, reviewed_identity_sequence: sequence });
  requirePinnedIdentity(root, run.id);
});
test("invalid requests keep their functional outcome, external HTTP failures may resume", () => {
  for (const code of [400, 404, 413, 422])
    assert.equal(externalOutcome("HTTP_" + code), false);
  for (const code of [401, 402, 403, 408, 429, 500, 503])
    assert.equal(externalOutcome("HTTP_" + code), true);
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
