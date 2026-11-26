import assert from "node:assert/strict";
import test from "node:test";
import { retestQuota } from "../../online/benchmark/stage-c-go-quota.ts";

const window = (remaining: number) => ({
  deadline: () => Date.now() + remaining,
  signal: new AbortController().signal,
});
const ok = { status: "ok", percent: 0, resetsAt: "2030-01-01T00:00:00Z" };
const usage = { rolling: ok, weekly: ok, monthly: ok };
test("only transient metadata failures can consume the two zero-send rechecks", async () => {
  let reads = 0;
  const result = await retestQuota(
    "mock",
    async (url, init) => {
      assert.equal(init?.method ?? "GET", "GET");
      assert.ok(init?.signal);
      reads++;
      if (reads < 3) throw new TypeError("offline transport failure");
      return Response.json({ usage });
    },
    window(120000),
  );
  assert.equal(reads, 3);
  assert.deepEqual(result, usage);
  for (const [status, count] of [
    [401, 1],
    [403, 1],
    [503, 3],
  ]) {
    reads = 0;
    await assert.rejects(
      retestQuota(
        "mock",
        async () => {
          reads++;
          return new Response(null, { status });
        },
        window(120000),
      ),
    );
    assert.equal(reads, count);
  }
});
test("insufficient time or an aborted request causes zero metadata reads", async () => {
  let reads = 0;
  const transport = async () => {
    reads++;
    return Response.json({ usage });
  };
  await assert.rejects(
    retestQuota("mock", transport, window(44000)),
    /WINDOW_EXHAUSTED/,
  );
  await assert.rejects(
    retestQuota("mock", transport, {
      ...window(120000),
      signal: AbortSignal.abort(),
    }),
  );
  assert.equal(reads, 0);
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ledger } from "../../online/benchmark/campaign.ts";
import { recoverySender } from "../../online/benchmark/stage-c-recovery-sender.ts";
import { meteredFetch } from "../../online/benchmark/live-model.ts";
import { fingerprint } from "../../online/benchmark/source.ts";
import { writeJSON } from "../../online/benchmark/io.ts";

test("C12b gate waits for the actual metered stream settlement and for the task, with time left", async (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "retest-sender-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true }));
  writeJSON(path.join(root, "campaign/manifest.json"), {
    version: 1,
    approval_id: "fixture",
    source: fingerprint(),
    facility: root,
    state: "OPEN",
    ceiling_usd: null,
    created_at: new Date().toISOString(),
  });
  const evidence = path.join(root, "evidence");
  fs.mkdirSync(evidence, { mode: 0o700 });
  let taskActive = true,
    main = 0;
  const gate = recoverySender(
    () => [...ledger(root).entries.values()].every((e) => e.settled),
    () => taskActive,
  );
  const signal = AbortSignal.timeout(10000);
  const deadline = Date.now() + 120000;
  let bytes!: ReadableStreamDefaultController<Uint8Array>;
  const fetcher = meteredFetch(
    {
      root,
      run: "fixture",
      model: "deepseek-flash",
      maxSends: 1,
      evidence,
      key: "offline-placeholder",
    },
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            bytes = c;
          },
        }),
      ),
  );
  const delayed = gate.admit(signal, "main", deadline, async () => {
    main++;
  });
  const response = await gate.admit(signal, "task", deadline, async () => {
    assert.equal(gate.check(), false);
    return fetcher("https://api.deepseek.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "deepseek-flash",
        stream: true,
        max_tokens: 64,
        messages: [],
      }),
    });
  });
  assert.equal(gate.check(), false);
  taskActive = false;
  gate.writing = true;
  bytes.enqueue(
    new TextEncoder().encode(
      'data: {"model":"deepseek-flash","usage":{"prompt_tokens":9,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
    ),
  );
  bytes.close();
  await response.text();
  assert.equal(gate.check(), true);
  assert.equal(main, 0);
  await assert.rejects(
    gate.admit(signal, "main", Date.now() + 39000, async () => {
      main++;
    }),
    /WINDOW_EXHAUSTED/,
  );
  gate.writing = false;
  await delayed;
  assert.equal(main, 1);
  assert.equal(ledger(root).entries.size, 1);
});

import { sha, appendJSON } from "../../online/benchmark/io.ts";
import {
  deliveryRequest,
  nativeWriteRecipe,
} from "../../online/benchmark/stage-c-fault.ts";
import { retestWorkload } from "../../online/benchmark/stage-c-targeted-policy.ts";
import {
  checkWorkloadClosure,
  workloadLanes,
} from "../../online/benchmark/targeted-reader-workload.ts";
import { targetedWorkloadResult } from "../../online/benchmark/targeted-workload-result.ts";

test("a sealed C12b trial exports independently, retaining duplicate-write FAIL across both interruption boundaries", (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "retest-export-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true }));
  const run = "c719ab53-25b4-490b-9172-604f650aa84f",
    lineage = "8612b24b-cf14-4eb5-87f1-cd34f5251c19";
  const dir = path.join(root, "evidence", run),
    lane = workloadLanes.c12b;
  const save = (file: string, value: unknown) => {
    writeJSON(file, value);
    return sha(fs.readFileSync(file));
  };
  const f = save(path.join(root, "configs/stage-c-freeze.json"), {
    targeted_supplement: retestWorkload,
    batch: Object.values(workloadLanes).map((lane) => ({
      targeted_supplement: true,
      lane: { lane },
    })),
  });
  const bound = {
    run,
    lineage,
    domain: "d",
    execution: "e",
    operation: "o",
    parameter_hash: sha("p"),
    request: deliveryRequest(run, nativeWriteRecipe),
    resource: "/isolated/continuity.txt",
    expected_hash: sha("alpha"),
    observed_hash: sha("alpha"),
    pid: 321,
    task_contexts: [sha("task context")],
  };
  const members: Record<string, string> = {};
  const record = (name: string, o: unknown) => {
    members[name] = save(path.join(dir, name), o);
  };
  record("stage-c-barrier.json", bound);
  const next = { ...bound, pid: 322, operation: "again" };
  for (const name of [
    "stage-c-write-attempts.jsonl",
    "stage-c-physical-writes.jsonl",
  ]) {
    const file = path.join(dir, name);
    for (const w of [bound, next]) appendJSON(file, w);
    members[name] = sha(fs.readFileSync(file));
  }
  const id = "mock-send",
    verify = { request_id: "verify", acceptance: "ACCEPTED" };
  const obs = {
    operation: bound.operation,
    old_exit: sha("old"),
    new_start: sha("new"),
    pre_restart_journal: sha("before"),
    unknown_journal: sha("unknown"),
    final_journal: sha("after"),
    verify_request: "verify",
    verify_receipt_sha256: sha(JSON.stringify(verify)),
    physical_writes: 2,
    content_sha256: sha("alpha"),
    reconciled: true,
    kind: "DIRECT_SAME_DOMAIN",
    effects: "FAIL",
    host_assisted: true,
  };
  record("stage-c-recovery-receipt.json", {
    result: obs,
    bound,
    verify,
    restart: {
      kind: obs.kind,
      old_exit: { sha256: obs.old_exit },
      new_start: { sha256: obs.new_start },
    },
  });
  const payload = { model: "offline" };
  save(path.join(dir, "send-" + id + ".json"), {
    id,
    payload,
    attribution: { role: "task", context_sha256: bound.task_contexts[0] },
  });
  const events = [
    {
      type: "RESERVE",
      attempt: {
        id,
        lane,
        run,
        request_sha256: sha(JSON.stringify(payload)),
        reserved_usd: 0.1,
      },
    },
    {
      type: "SETTLE",
      id,
      outcome: "RESPONSE_COMPLETE",
      actual_usd: 0,
      usage: { response_complete: true, route: "opencode-go" },
    },
  ];
  fs.mkdirSync(path.join(root, "campaign"));
  let previous = "0".repeat(64);
  for (const [i, event] of events.entries()) {
    const sequence = i + 1,
      hash = sha(JSON.stringify(event) + previous + sequence);
    appendJSON(path.join(root, "campaign/attempts.jsonl"), {
      sequence,
      previous,
      hash,
      event,
    });
    previous = hash;
  }
  for (const [status, complete] of [
    ["COMPLETED", true],
    ["INCOMPLETE", true],
    ["INCOMPLETE", false],
  ] as const) {
    const report = save(path.join(dir, "stage-c-trial.json"), {
      run,
      descriptor: { scenario: "C12b" },
      evidence_class: "LIVE",
      physical_provider_sends: 1,
      recovery_lineage: lineage,
      recovery_members: members,
      observations: complete
        ? [
            obs,
            {
              run,
              physical: {},
              witness: { assertions: {}, structural_gaps: [] },
            },
          ]
        : [],
    });
    save(path.join(root, "campaign/stage-c-dispatch.json"), {
      freeze_sha256: f,
      current: workloadLanes["c16-repeat1"],
      ended: false,
      terminals: { [lane]: { status, run, report_sha256: report } },
    });
    const closure = checkWorkloadClosure(root, f, undefined, "c12b");
    assert.throws(() => checkWorkloadClosure(root, f), /CLOSURE/);
    const result = targetedWorkloadResult(root, closure, "c12b");
    assert.equal(result.assertions.effects, "FAIL");
    assert.equal(result.gate, status === "COMPLETED" ? "CLOSED" : "OPEN");
    assert.equal(
      result.verdict,
      status === "COMPLETED" ? "FAIL" : "UNRESOLVED",
    );
  }
});

import { execFileSync } from "node:child_process";
import { repository } from "../../online/benchmark/io.ts";
test("R71 published view is reproduced unchanged beneath the two retest positions", (t) => {
  const tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "retest-coverage-")),
  );
  t.after(() => fs.rmSync(tmp, { recursive: true }));
  const parent = fs.readFileSync(
    path.join(repository, "evidence/issue122-targeted-supplement.json"),
  );
  const retest = {
    ...JSON.parse(parent.toString()),
    schema: "issue122-retest-result-v1",
    parent_supplement_sha256: sha(parent),
    archived_reader_rows: [],
    workload_freeze_sha256: "a".repeat(64),
  };
  const file = path.join(tmp, "retest.json");
  writeJSON(file, retest);
  const project = (name: string, args: string[]) => {
    const out = path.join(tmp, name);
    execFileSync(
      "python3",
      ["scripts/export-issue122-coverage.py", "--output", out, ...args],
      { cwd: repository },
    );
    return JSON.parse(fs.readFileSync(out, "utf8"));
  };
  const old = project("old", []),
    next = project("new", [
      "--retest",
      file,
      "--retest-sha256",
      sha(fs.readFileSync(file)),
    ]);
  assert.equal(old.repeat_assertion_cells, 189);
  assert.deepEqual(
    next.effective_assertion_coverage,
    old.effective_assertion_coverage,
  );
  assert.deepEqual(next.matrix, old.matrix);
  const seen = new Set();
  next.retest_assertion_coverage.forEach((g: any, i: number) => {
    for (const [j, cell] of g.positions.entries()) {
      if (["C16-combined", "C12b"].includes(g.case) && cell.repeat === 1) {
        seen.add(g.case);
        assert.equal(cell.origin, "retest");
        assert.equal(cell.freeze_sha256, retest.workload_freeze_sha256);
      } else
        assert.deepEqual(
          cell,
          old.effective_assertion_coverage[i].positions[j],
        );
    }
  });
  assert.deepEqual([...seen].sort(), ["C12b", "C16-combined"]);
});

import { installStageCFault } from "../../online/benchmark/stage-c-fault.ts";
test("a verified physical write with incorrect initial bytes is recorded before the crash barrier", (t) => {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "retest-prefault-")),
  );
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const resource = path.join(dir, "continuity.txt");
  fs.writeFileSync(resource, "wrong");
  const op = {
    id: "op",
    state: "DISPATCHED",
    scope: { execution_id: "e" },
    action: { action: "file.write", resource, parameters_hash: "p" },
  };
  const auth = {
    finish(_id: string, _receipt: any, _outcome: any) {},
    dispatch() {},
  };
  const run = "c719ab53-25b4-490b-9172-604f650aa84f",
    request = deliveryRequest(run, nativeWriteRecipe);
  const store = {
    all: () => [],
    find: () => ({ owner_id: "domain" }),
    get: (kind: string) =>
      kind === "Operation"
        ? op
        : kind === "Execution"
          ? { task_id: "task" }
          : { proposal_request_id: request },
    bytes: () => Buffer.from("wrong"),
  };
  installStageCFault(
    { authorization: auth, store } as any,
    { id: run, lineage: "lineage", evidence: dir } as any,
    () => {
      throw Error("PARK");
    },
    { writing: true, check: () => true },
  );
  assert.throws(
    () =>
      auth.finish(
        "op",
        { result: {}, evidence: { sha256: sha("wrong") } },
        "APPLIED",
      ),
    /PARK/,
  );
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(dir, "stage-c-target-failure.json"), "utf8"),
    ).reason,
    "C12B_PREFAULT_CONTENT_MISMATCH",
  );
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(dir, "stage-c-physical-writes.jsonl"), "utf8"),
    ).observed_hash,
    sha("wrong"),
  );
  assert.equal(fs.existsSync(path.join(dir, "stage-c-barrier.json")), false);
});
