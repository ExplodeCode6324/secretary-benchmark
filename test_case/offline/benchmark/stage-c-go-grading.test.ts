import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sha, repository } from "../../online/benchmark/io.ts";
import { gradeJSONBytes } from "../../online/benchmark/grading-transaction.ts";
import { generateCalibration } from "../../online/benchmark/stage-b-report-calibration.ts";
import { scoringRubric } from "../../online/benchmark/stage-c-grading.ts";
import {
  goReader,
  goReaderPolicy as p,
  goVisibilityVersion,
  admittedReaderQuery,
  renderReaderQuery,
  newVisibilityControls,
  officialReader,
  visibilityV2,
} from "../../online/benchmark/stage-c-visibility-rubric.ts";
import {
  goReaderResponse,
  goMetering,
  verifyGoCalibrationReference,
} from "../../online/benchmark/stage-c-go-grading.ts";

const unreflected = { rolling: 0.0111, weekly: 0.0111, monthly: 0.0111 };
function bindFixtureMetadata(t: any) {
  const b = {
    stage: t.stage,
    batch: t.batch,
    slot: t.slot,
    packet_sha256: t.packet_sha256,
    query_sha256: t.input_sha256,
    decision_sha256: t.decision_sha256,
    go_local_unreflected_usd: t.go_local_unreflected_usd,
    ...(t.stage === "candidate"
      ? {
          calibration_returned_model: t.calibration_returned_model,
          calibration_native_at: t.calibration_native_at,
        }
      : {}),
  };
  t.binding_metadata_utf8 = JSON.stringify(b, null, 2) + "\n";
  t.metadata_sha256 = sha(t.binding_metadata_utf8);
}
function fixture() {
  const rubric = scoringRubric(goReader, goVisibilityVersion),
    semantic = generateCalibration(),
    more = newVisibilityControls();
  const packet = {
    rubric,
    controls: [
      ...semantic.packet.controls,
      ...more.reader.map((v) => ({ ...v, assertion: "visibility" })),
    ],
  };
  const key = [...semantic.key, ...more.key];
  assert.equal(key.length, 28);
  const digest = sha(gradeJSONBytes(packet)),
    freeze = "a".repeat(64),
    query = admittedReaderQuery(packet);
  const answer = {
    judge: { provider: p.provider, model: p.model, reasoning_effort: "max" },
    packet_sha256: digest,
    labels: key.map((k) => ({ id: k.id, verdict: k.expected })),
  };
  const raw = JSON.stringify(answer),
    at = "2026-11-25T04:12:12.000+00:00";
  const serialized = JSON.stringify({
    messages: [{ role: "user", content: query }],
    model: p.model,
    max_tokens: 49152,
    reasoning_effort: "max",
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: "enabled" },
  });
  const windows = Object.fromEntries(
    ["weekly", "rolling", "monthly"].map((k) => [
      k,
      { status: "ok", percent: 1, resetsAt: at },
    ]),
  );
  const d = {
    stage: "calibration",
    request_model: p.model,
    model: p.model,
    provider: p.provider,
    endpoint: p.endpoint,
    reasoning_effort: "max",
    thinking_type: "enabled",
    max_tokens: 49152,
    wire_bytes: Buffer.byteLength(serialized),
    wire_sha256: sha(serialized),
    input_sha256: sha(query),
    packet_sha256: digest,
    decision_sha256: freeze,
    native_entry: "AIAgent.run_conversation",
    native_session_header_verified: true,
    session_created_by_hermes: true,
    tools: 0,
    fallback: false,
    automatic_retries: 0,
    inference_dispatches: 1,
    billing_basis: p.billing_basis,
    metadata_sha256: "b".repeat(64),
    slot: 6,
    batch: 4,
    created: at,
    go_usage_before: { url: p.usage_endpoint, status: 200, at, data: windows },
    go_local_unreflected_usd: unreflected,
    go_headroom: goHeadroom(
      { url: p.usage_endpoint, status: 200, at, data: windows },
      true,
      unreflected,
    ),
    go_catalog: {
      url: p.models_endpoint,
      status: 200,
      at,
      data: {
        id: p.model,
        canonical_id: p.canonical_id,
        reasoning_supported: true,
        reasoning_efforts: ["low", "high", "max"],
        output_token_limit: 384000,
      },
    },
  };
  bindFixtureMetadata(d);
  const t = {
    ...d,
    raw_sha256: sha(raw),
    usage: { prompt_tokens: 200, completion_tokens: 600, total_tokens: 800 },
    returned_model: p.model,
    finished: at,
    status: 200,
    http_status: 200,
    finish_reason: "stop",
    quota_stop: false,
    go_usage_after: d.go_usage_before,
    charged_usd: null,
    pricing_window: null,
    go_allowance: 0.012,
  };
  return {
    packet,
    key,
    answer,
    freeze,
    envelope: { raw, dispatch: d, transport: t },
  };
}

test("Go preserves official v2 texts and validates independent wire, quota, and allowance evidence", () => {
  const { packet, freeze, envelope, answer } = fixture();
  assert.deepEqual(goReaderResponse(envelope, packet, freeze), answer);
  assert.equal(goMetering(envelope.transport).charged_usd, null);
  assert.equal(goMetering(envelope.transport).allowance, 0.012);
  const prior = {
    ...packet,
    rubric: scoringRubric(officialReader, visibilityV2),
  };
  assert.match(
    renderReaderQuery(prior),
    /"provider":"deepseek","model":"deepseek-flash"/,
  );
  assert.match(
    renderReaderQuery(packet),
    /"provider":"opencode-go","model":"deepseek-v4.1-flash"/,
  );
  for (const apply of [
    (e: any) => {
      e.transport.input_sha256 = "0".repeat(64);
    },
    (e: any) => {
      e.transport.wire_sha256 = e.dispatch.wire_sha256 = "0".repeat(64);
    },
    (e: any) => {
      e.transport.go_catalog.data.canonical_id = "deepseek-flash";
    },
    (e: any) => {
      e.transport.go_usage_before.data.rolling.percent = 100;
    },
    (e: any) => {
      e.transport.charged_usd = 0;
    },
    (e: any) => {
      e.transport.calculated_charge_usd = 0.1;
    },
    (e: any) => {
      e.transport.slot = e.dispatch.slot = 5;
    },
    (e: any) => {
      e.transport.native_session_header_verified = false;
    },
  ]) {
    const copy = structuredClone(envelope);
    apply(copy);
    assert.throws(() => goReaderResponse(copy, packet, freeze));
  }
  const mismatch = structuredClone(envelope);
  mismatch.transport.returned_model = "deepseek-flash";
  assert.equal(
    goReaderResponse(mismatch, packet, freeze).rejected,
    "RETURNED_MODEL_MISMATCH",
  );
  const declined = structuredClone(envelope);
  declined.raw = "";
  Object.assign(declined.transport, {
    raw_sha256: sha(""),
    quota_stop: true,
    finish_reason: null,
    http_status: 429,
    status: 429,
    returned_model: null,
    usage: null,
  });
  assert.equal(
    goReaderResponse(declined, packet, freeze).mechanical,
    "NO_RESPONSE",
  );
});

test("one original 28/28 source receipt authorizes two reference partitions without a second attempt", () => {
  const { packet, key, freeze, envelope, answer } = fixture();
  const result = {
    status: "PASSED",
    submission: answer,
    reader_evidence: envelope,
    reader_query_sha256: sha(admittedReaderQuery(packet)),
    response_sha256: sha(gradeJSONBytes(answer)),
  };
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "go-grade-fixture-")),
  );
  const base = "oracles/completion/calibration/";
  const hash = (value: any) => sha(gradeJSONBytes(value));
  const origin = {
    freeze_sha256: freeze,
    archive_sha256: "8".repeat(64),
    packet_sha256: hash(packet),
    key_sha256: hash(key),
    rubric_sha256: hash(packet.rubric),
    receipt_sha256: hash(result),
    transport_sha256: hash(envelope.transport),
  };
  function write(name: string, value: any) {
    const f = path.join(root, name),
      b = gradeJSONBytes(value);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, b, { mode: 0o600 });
    return { name, sha256: sha(b), bytes: b.length };
  }
  function build(ref: any, r: any) {
    const files = [
      write(base + "blind.json", packet),
      write(base + "key.json", key),
      write(base + "go-origin-result.json", r),
      write(base + "go-origin-transport.json", r.reader_evidence.transport),
      write(base + "go-origin.json", ref),
    ];
    const id = "00000000-0000-4000-b000-000000000001",
      proof = {
        version: "secretary-grading-commit-v1",
        transaction_id: id,
        operation: "fixture",
        parent_child: null,
        files,
      };
    write("oracles/.grading-transactions/" + id + "/prepare.json", proof);
    write("oracles/grading-commit-" + id + ".json", proof);
  }
  try {
    build(origin, result);
    for (const partition of [6, 7]) {
      const inputs = {
        go_continuation: {
          source_partition: 5,
          partition,
          prior_freezes: { "5": "9".repeat(64) },
          calibration_origin: origin,
        },
      };
      const checked = verifyGoCalibrationReference(root, inputs);
      assert.equal(checked.kind, "REFERENCE");
      assert.equal(checked.inference_dispatches, 0);
      assert.equal(
        fs.existsSync(path.join(root, base + "attempt-1.json")),
        false,
      );
      assert.throws(() =>
        verifyGoCalibrationReference(root, {
          go_continuation: {
            ...inputs.go_continuation,
            calibration_origin: { ...origin, archive_sha256: "7".repeat(64) },
          },
        }),
      );
    }
    const bad = structuredClone(result);
    bad.submission.labels[0].verdict = "incorrect";
    const changed = { ...origin, receipt_sha256: hash(bad) };
    build(changed, bad);
    assert.throws(() =>
      verifyGoCalibrationReference(root, {
        go_continuation: {
          source_partition: 5,
          partition: 7,
          calibration_origin: changed,
        },
      }),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

import {
  archivedGoAssessment,
  goCandidateUsage,
  prepareGoCalibrationTemplate,
  prepareGoCalibrationReference,
  verifyGoCalibrationTemplate,
  withholdGoCalibrationReference,
  goCalibrationReportReference,
  goHeadroom,
  calibrationAgeOK,
  goGradeGate,
} from "../../online/benchmark/stage-c-go-grading.ts";

test("archive replays source and candidate native transports and binds two zero-send references", () => {
  const source = fixture(),
    sourceHash = source.freeze,
    archiveHash = "c".repeat(64);
  const freeze: any = {
    batch_index: 5,
    go_continuation: { partition: 5, source_partition: 5 },
    grade: {
      version: goVisibilityVersion,
      reader: goReader,
      rubric_sha256: sha(gradeJSONBytes(source.packet.rubric)),
      packet_sha256: sha(gradeJSONBytes(source.packet)),
      key_sha256: sha(gradeJSONBytes(source.key)),
      max_attempts: 1,
      transport: p,
    },
  };
  const files = new Map<string, Buffer>();
  function put(lane: string, name: string, val: any, transport = false) {
    files.set(
      (transport ? "reports/go-reader/" : "oracles/completion/") +
        lane +
        "/" +
        name,
      gradeJSONBytes(val),
    );
  }
  function get(name: string, archived: string) {
    assert.equal(
      name,
      archived.replace(
        /^oracles\/completion\/|^reports\/go-reader\//,
        "go-reader/",
      ),
    );
    const bytes = files.get(archived);
    assert.ok(bytes, archived);
    return bytes;
  }
  function capture(
    lane: string,
    packet: any,
    answer: any,
    slot: number,
    status: string,
  ) {
    const q = admittedReaderQuery(packet),
      packetSha = sha(gradeJSONBytes(packet));
    const envelope = structuredClone(source.envelope) as any;
    envelope.raw = JSON.stringify(answer);
    const serialized = JSON.stringify({
      messages: [{ role: "user", content: q }],
      model: p.model,
      max_tokens: 49152,
      reasoning_effort: "max",
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: "enabled" },
    });
    for (const t of [envelope.dispatch, envelope.transport])
      Object.assign(t, {
        stage: lane === "calibration" ? "calibration" : "candidate",
        batch: 4,
        slot,
        go_headroom: goHeadroom(
          t.go_usage_before,
          lane === "calibration",
          t.go_local_unreflected_usd,
        ),
        ...(lane === "calibration"
          ? {}
          : {
              calibration_native_at: source.envelope.transport.go_catalog.at,
              calibration_returned_model: p.model,
            }),
        packet_sha256: packetSha,
        input_sha256: sha(q),
        wire_bytes: Buffer.byteLength(serialized),
        wire_sha256: sha(serialized),
      });
    for (const t of [envelope.dispatch, envelope.transport])
      bindFixtureMetadata(t);
    envelope.transport.raw_sha256 = sha(envelope.raw);
    const r = {
      submission: answer,
      status,
      reader_evidence: envelope,
      reader_query_sha256: sha(q),
      response_sha256: sha(gradeJSONBytes(answer)),
    };
    put(lane, "blind.json", packet);
    put(lane, "attempt-1.json", { number: 1, packet_sha256: packetSha });
    put(lane, "attempt-1-result.json", r);
    put(lane, "a-transport.json", envelope.transport, true);
    return { r, t: envelope.transport };
  }
  const calibration = capture(
    "calibration",
    source.packet,
    source.answer,
    6,
    "PASSED",
  );
  put("calibration", "key.json", source.key);
  const cp = {
    rubric: source.packet.rubric,
    assertions: ["a"],
    evidence: [{ id: "item", text: "synthetic" }],
  };
  const ca = {
    judge: source.answer.judge,
    packet_sha256: sha(gradeJSONBytes(cp)),
    assertions: [
      {
        assertion: "a",
        verdict: "PASS",
        rationale: "fixture",
        evidence: ["item"],
      },
    ],
  };
  const cand = capture("synthetic", cp, ca, 12, "ACCEPTED");
  const shifted = structuredClone(cand.r.reader_evidence);
  shifted.transport.returned_model = p.canonical_id;
  assert.equal(
    goReaderResponse(shifted, cp, sourceHash).rejected,
    "RETURNED_MODEL_MISMATCH",
  );
  const stale = structuredClone(cand.r.reader_evidence);
  for (const t of [stale.transport, stale.dispatch])
    t.calibration_native_at = "2026-11-22T00:00:00Z";
  assert.throws(() => goReaderResponse(stale, cp, sourceHash), /BINDING/);
  const rows = [
    {
      source_lineage: "synthetic",
      assessment_attempts: 1,
      assessment_status: "ACCEPTED",
      go_reader_metering: goMetering(cand.t),
    },
  ];
  const result: any = {
    freeze_sha256: sourceHash,
    rows,
    billing_basis: p.billing_basis,
    cash_charge_usd: null,
    charged_usd: null,
    known_usd: null,
    unresolved_cost_reservation_usd: null,
    tariff_estimate_usd: 0.01,
    tariff_guard_usd: 0.02,
    unresolved_tariff_reservation_usd: 0.01,
    candidate_reader_metered_usd: null,
    candidate_reader_go: goCandidateUsage(rows),
  };
  const check = (f = freeze, res = result, hash = sourceHash) =>
    archivedGoAssessment(f, hash, archiveHash, res, files, get);
  const {
    calibration: { origin, ...c },
  } = check();
  assert.equal(c.kind, "ORIGIN");
  assert.equal(c.attempts, 1);
  assert.equal(c.go_reader_metering.usage.total_tokens, 800);
  assert.equal(
    origin.transport_sha256,
    sha(files.get("reports/go-reader/calibration/a-transport.json")!),
  );
  assert.equal(result.candidate_reader_go.inference_dispatches, 1);
  const candidateTransport = "reports/go-reader/synthetic/a-transport.json",
    original = files.get(candidateTransport)!;
  files.set(
    candidateTransport,
    gradeJSONBytes({ ...cand.t, go_allowance: 100 }),
  );
  assert.throws(() => check(), /ARCHIVED_TRANSPORT/);
  files.set(candidateTransport, original);
  assert.throws(
    () => check(freeze, { ...result, cash_charge_usd: 0.01 }),
    /POLICY/,
  );
  assert.throws(
    () =>
      check(freeze, {
        ...result,
        candidate_reader_go: {
          ...result.candidate_reader_go,
          prompt_tokens: 999,
        },
      }),
    /USAGE/,
  );
  files.clear();
  put("calibration", "blind.json", source.packet);
  put("calibration", "key.json", source.key);
  const idleResult = {
    ...result,
    rows: [],
    candidate_reader_go: goCandidateUsage([]),
  };
  const withheld = check(
    {
      ...freeze,
      go_continuation: {
        ...freeze.go_continuation,
        calibration_withheld: true,
      },
    },
    idleResult,
  );
  assert.deepEqual(withheld.calibration, {
    kind: "WITHHELD",
    status: "NOT_TESTED",
    packet_sha256: origin.packet_sha256,
    receipt_sha256: null,
    attempts: 0,
    inference_dispatches: 0,
  });
  assert.throws(
    () =>
      goGradeGate(
        { ...freeze.go_continuation, calibration_withheld: true },
        true,
      ),
    /WITHHELD/,
  );
  assert.throws(
    () =>
      goGradeGate(
        { ...freeze.go_continuation, calibration_withheld: true },
        false,
      ),
    /WITHHELD/,
  );
  assert.equal(goGradeGate({ source_partition: 7, partition: 7 }, true), false);
  put("calibration", "go-origin.json", origin);
  put("calibration", "go-origin-result.json", calibration.r);
  put("calibration", "go-origin-transport.json", calibration.t);
  for (const partition of [6, 7]) {
    const hash = String(partition).repeat(64),
      go_continuation = {
        source_partition: 5,
        partition,
        calibration_origin: origin,
      };
    const local = {
      ...idleResult,
      freeze_sha256: hash,
      go_calibration_reference: {
        status: "PASSED",
        kind: "REFERENCE",
        inference_dispatches: 0,
        origin,
      },
    };
    const r = check(
      { ...freeze, batch_index: partition, go_continuation },
      local,
      hash,
    );
    assert.equal(r.calibration.attempts, 0);
    assert.equal(r.calibration.receipt_sha256, origin.receipt_sha256);
    assert.throws(() => goGradeGate(go_continuation, true), /ALREADY_SCORED/);
    const bad = {
      ...go_continuation,
      calibration_origin: { ...origin, receipt_sha256: "e".repeat(64) },
    };
    assert.throws(
      () =>
        check(
          { ...freeze, batch_index: partition, go_continuation: bad },
          local,
          hash,
        ),
      /REFERENCE_BINDING/,
    );
  }
  const pending = {
    freeze_sha256: sourceHash,
    packet_sha256: origin.packet_sha256,
    key_sha256: origin.key_sha256,
    rubric_sha256: origin.rubric_sha256,
  };
  const later = {
    ...freeze,
    batch_index: 7,
    go_continuation: {
      source_partition: 5,
      partition: 7,
      pending_calibration: pending,
    },
  };
  const linked = {
    status: "PASSED",
    kind: "REFERENCE",
    inference_dispatches: 0,
    origin,
  };
  put("calibration", "go-pending.json", pending);
  assert.equal(
    check(later, { ...idleResult, go_calibration_reference: linked })
      .calibration.kind,
    "REFERENCE",
  );
  for (const f of [
    "go-origin.json",
    "go-origin-result.json",
    "go-origin-transport.json",
  ])
    files.delete("oracles/completion/calibration/" + f);
  assert.throws(() => check(later, idleResult));
  const failure = {
    ...pending,
    archive_sha256: archiveHash,
    receipt_sha256: "9".repeat(64),
    status: "FAILED",
  };
  const ref = {
    status: "NOT_TESTED",
    kind: "WITHHELD",
    attempts: 0,
    inference_dispatches: 0,
    receipt_sha256: null,
    source_failure: failure,
  };
  put("calibration", "go-withheld.json", failure);
  const failed = check(later, {
    ...idleResult,
    go_calibration_reference: ref,
  }).calibration;
  assert.equal(failed.attempts, 0);
  assert.deepEqual(failed.source_failure, failure);
  assert.throws(
    () =>
      check(later, {
        ...idleResult,
        go_calibration_reference: {
          ...ref,
          source_failure: { ...failure, status: "PASSED" },
        },
      }),
    /WITHHELD/,
  );
});

test("Go quota ceiling, exact 24-hour reuse boundary and canonical serving ID", () => {
  const { envelope, packet, freeze, answer } = fixture(),
    before = structuredClone(envelope.transport.go_usage_before);
  before.data.rolling.percent = 97.1;
  assert.equal(goHeadroom(before, true, unreflected).admitted, true);
  assert.equal(goHeadroom(before, false, unreflected).admitted, false);
  const lo = "2026-11-25T01:02:03Z",
    hi = "2026-11-26T01:02:03Z";
  assert.equal(calibrationAgeOK(lo, hi), true);
  assert.equal(calibrationAgeOK(lo, "2026-11-26T01:02:03.001Z"), false);
  assert.equal(calibrationAgeOK(hi, lo), false);
  envelope.transport.returned_model = p.canonical_id;
  assert.deepEqual(goReaderResponse(envelope, packet, freeze), answer);
});

test("stale usage snapshot subtracts each outstanding window; native balance stops scoring", () => {
  const { envelope, freeze, packet } = fixture(),
    w = envelope.transport.go_usage_before;
  assert.equal(
    goHeadroom(w, true, { rolling: 0, weekly: 49, monthly: 0 }).admitted,
    false,
  );
  assert.equal(
    goHeadroom(w, true, { rolling: 0, weekly: 0, monthly: 98 }).admitted,
    false,
  );
  const near = { rolling: 19.6 - 0.2162688, weekly: 0, monthly: 0 };
  assert.equal(goHeadroom(w, false, near).admitted, true);
  assert.equal(
    goHeadroom(w, false, { ...near, rolling: near.rolling + 0.00000001 })
      .admitted,
    false,
  );
  assert.throws(
    () => goHeadroom(w, true, { rolling: 0, monthly: 0 }),
    /LOCAL_RESERVATIONS/,
  );
  assert.throws(
    () => goHeadroom(w, true, { ...unreflected, weekly: -1 }),
    /LOCAL_RESERVATIONS/,
  );
  const forged = structuredClone(envelope);
  forged.transport.go_local_unreflected_usd = { ...unreflected, weekly: 99 };
  assert.throws(() => goReaderResponse(forged, packet, freeze), /BINDING/);
  const billing: any = structuredClone(envelope);
  Object.assign(billing.transport, {
    go_billing_source: "balance",
    go_reported_cash_usd: 0.02,
    go_list_cost_usd: 0.03,
    quota_stop: true,
  });
  assert.equal(
    goReaderResponse(billing, packet, freeze).rejected,
    "BALANCE_BILLING",
  );
  const metering = goMetering(billing.transport);
  assert.equal(metering.charged_usd, null);
  assert.equal(metering.reported_cash_usd, 0.02);
  assert.equal(metering.list_cost_usd, 0.03);
  billing.transport.quota_stop = false;
  assert.throws(
    () => goReaderResponse(billing, packet, freeze),
    /BALANCE_BILLING_HOLD/,
  );
  billing.transport.go_catalog.data.output_token_limit = 49151;
  assert.throws(() => goReaderResponse(billing, packet, freeze), /BINDING/);
});

test("deferred template survives workload freeze and is bound once after a real source result", async () => {
  const { packet, key, freeze, answer, envelope } = fixture(),
    b = gradeJSONBytes(packet),
    k = gradeJSONBytes(key);
  const pending = {
    freeze_sha256: freeze,
    packet_sha256: sha(b),
    key_sha256: sha(k),
    rubric_sha256: sha(gradeJSONBytes(packet.rubric)),
  };
  const receipt = {
    status: "PASSED",
    submission: answer,
    reader_evidence: envelope,
    reader_query_sha256: sha(admittedReaderQuery(packet)),
    response_sha256: sha(gradeJSONBytes(answer)),
  };
  const rb = gradeJSONBytes(receipt),
    tb = gradeJSONBytes(envelope.transport),
    origin = {
      ...pending,
      archive_sha256: "6".repeat(64),
      receipt_sha256: sha(rb),
      transport_sha256: sha(tb),
    };
  const inputs = {
    go_continuation: {
      source_partition: 5,
      partition: 6,
      pending_calibration: pending,
    },
  };
  const base = path.join(
      repository,
      ".local/benchmark/tests",
      "go-deferred-" + randomUUID(),
    ),
    root = path.join(base, "passed"),
    failed = path.join(base, "failed");
  const src = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "go-source-fixture-")),
  );
  try {
    for (const [name, data] of [
      ["blind.json", b],
      ["key.json", k],
      ["attempt-1-result.json", rb],
      ["a-transport.json", tb],
    ] as const)
      fs.writeFileSync(path.join(src, name), data, { mode: 0o600 });
    for (const f of [root, failed]) {
      const initial = await prepareGoCalibrationTemplate(f, b, k, pending);
      assert.equal(initial.kind, "PENDING");
      assert.deepEqual(verifyGoCalibrationTemplate(f, inputs), initial);
      assert.throws(
        () => verifyGoCalibrationReference(f, inputs),
        /PENDING_OR_WITHHELD/,
      );
    }
    const proof = await prepareGoCalibrationReference(root, src, origin);
    assert.deepEqual(
      await prepareGoCalibrationReference(root, src, origin),
      proof,
    );
    assert.deepEqual(verifyGoCalibrationReference(root, inputs), proof);
    assert.equal(
      fs.existsSync(
        path.join(root, "oracles/completion/calibration/attempt-1.json"),
      ),
      false,
    );
    const failure = {
      ...pending,
      archive_sha256: "3".repeat(64),
      receipt_sha256: "4".repeat(64),
      status: "MECHANICAL",
    };
    await assert.rejects(
      () => withholdGoCalibrationReference(root, inputs, failure),
      /WITHHELD_CONFLICT/,
    );
    const withheld = await withholdGoCalibrationReference(
      failed,
      inputs,
      failure,
    );
    assert.deepEqual(goCalibrationReportReference(failed, inputs), withheld);
    assert.throws(
      () => verifyGoCalibrationReference(failed, inputs),
      /PENDING_OR_WITHHELD/,
    );
    await assert.rejects(
      () => prepareGoCalibrationReference(failed, src, origin),
      /REFERENCE_CONFLICT/,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});
