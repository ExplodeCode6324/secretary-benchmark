import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { operatorCommand } from "../../online/benchmark/operator/cli.ts";
import { rootFor, openSeal } from "../../online/benchmark/operator/files.ts";
import { repository } from "../../online/benchmark/io.ts";

test.before(() => {
  fs.mkdirSync(path.join(repository, ".local"), { recursive: true });
});

test("a continuous workload grades every question and replays the full denominator", async () => {
  const directory = fs.mkdtempSync(
    path.join(repository, ".local", "question-series-"),
  );
  let original: string | undefined;
  try {
    const result: any = await operatorCommand("evaluate", [
      "--config",
      "examples/secretary-questions.json",
    ]);
    original = rootFor(result.run);
    const run = openSeal(path.join(original, "execution.json"));
    const report = JSON.parse(fs.readFileSync(result.json, "utf8"));
    const expected = run.manifest.suite.timeline.filter(
      (event: any) => event.type === "question",
    );
    assert.ok(expected.length >= 2);
    assert.deepEqual(report.coverage, {
      planned: expected.length,
      executed: expected.length,
      graded: expected.length,
    });
    assert.deepEqual(
      report.questions.map((q: any) => q.id),
      expected.map((q: any) => q.id),
    );
    const [first, later] = [run.events[1], run.events[4]];
    const { partitionAnswers } =
      await import("../../online/benchmark/operator/answer.ts");
    assert.ok(later.handledAt > first.handledAt && later.messages.length > 0);
    const selected = partitionAnswers(
      [...first.messages, ...later.messages],
      { loop_id: first.loop, updated_at: first.handledAt },
      [...first.attribution, ...later.attribution],
    );
    assert.deepEqual(selected.messages, first.messages);
    assert.deepEqual(selected.otherMessages, later.messages);
    assert.equal(
      report.otherMessageCount,
      run.events.reduce(
        (n: number, event: any) => n + event.otherMessages.length,
        0,
      ),
    );
    const plan = openSeal(path.join(original, "grades/original/plan.json"));
    assert.equal(plan.batches.length, 1);
    const input = JSON.parse(
      fs.readFileSync(
        path.join(original, "grades/original/packets/1/input.json"),
        "utf8",
      ),
    );
    assert.equal(input.packet.items.length, expected.length);
    for (const q of report.questions) {
      const item = input.packet.items.find(
        (it: any) => it.question_id === q.id,
      );
      assert.equal(
        item.question,
        expected.find((event: any) => event.id === q.id).text,
      );
      assert.deepEqual(
        item.reference_facts
          .filter((f: any) => f.kind === "required")
          .map((f: any) => f.text),
        expected.find((e: any) => e.id === q.id).reference.required,
      );
      assert.equal(item.answer, q.answer);
    }
    const { archiveFacility } =
      await import("../../online/benchmark/archive.ts");
    const archive = await archiveFacility(original, directory);
    assert.equal(archive.status, "DRY_RUN");
    const exported = path.join(directory, "portable");
    await operatorCommand("export-run", [
      "--run",
      result.run,
      "--output",
      exported,
    ]);
    const rebuilt: any = await operatorCommand("report", [
      "--bundle",
      exported,
      "--output",
      path.join(directory, "replay"),
    ]);
    assert.deepEqual(
      fs.readFileSync(rebuilt.json),
      fs.readFileSync(result.json),
    );
    assert.deepEqual(
      fs.readFileSync(rebuilt.report),
      fs.readFileSync(result.report),
    );
  } finally {
    if (original) fs.rmSync(original, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("reply attribution excludes late, unrelated, incomplete and withdrawn output", async () => {
  const { isAnswerMessage } =
    await import("../../online/benchmark/operator/answer.ts");
  const input = { loop_id: "current", updated_at: "2026-11-01T00:00:04Z" };
  const call = { completed_at: "2026-11-01T00:00:03Z" };
  const context = { loop_id: "current", purpose: "MAIN" };
  assert.ok(isAnswerMessage(input, call, context, {}));
  assert.ok(
    !isAnswerMessage(
      input,
      { completed_at: "2026-11-01T00:00:05Z" },
      context,
      {},
    ),
  );
  assert.ok(
    !isAnswerMessage(input, call, { ...context, loop_id: "previous" }, {}),
  );
  assert.ok(!isAnswerMessage(input, call, { ...context, purpose: "TASK" }, {}));
  assert.ok(!isAnswerMessage(input, {}, context, {}));
  assert.ok(!isAnswerMessage(input, call, context, { withdrawn: true }));
  assert.ok(!isAnswerMessage(input, call, context, { incomplete: true }));
});

test("normal target exit reaps surviving helpers and leaves an unrelated process alive", async () => {
  const { spawn } = await import("node:child_process");
  const { randomUUID } = await import("node:crypto");
  const { confirmGroupStopped } =
    await import("../../online/benchmark/operator/sandbox.ts");
  const separate = spawn(process.execPath, ["-e", "setInterval(()=>{},5000)"], {
    stdio: "ignore",
  });
  const childCode =
    "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},5000)'],{stdio:'ignore'}); child.unref(); process.stdout.write(String(child.pid));";
  const leader = spawn(
    process.execPath,
    [
      path.join(
        repository,
        "test_case/online/benchmark/operator/supervisor.mjs",
      ),
      "--run",
      randomUUID(),
      process.execPath,
      "-e",
      childCode,
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore", "ipc"] },
  );
  let helper = "";
  leader.stdout!.setEncoding("utf8").on("data", (chunk) => (helper += chunk));
  try {
    await new Promise<void>((resolve, reject) => {
      leader.once("close", () => resolve());
      leader.once("error", reject);
    });
    assert.ok(Number(helper) > 1);
    await confirmGroupStopped(leader.pid!);
    assert.throws(() => process.kill(Number(helper), 0), { code: "ESRCH" });
    assert.doesNotThrow(() => process.kill(separate.pid!, 0));
  } finally {
    separate.kill();
    if (leader.connected) leader.send("stop");
  }
});

test("fact scoring uses the time-specific key, validates every ID, and handles missing and oversized answers", async () => {
  const {
    factPacket,
    factResults,
    factPlan,
    itemFor,
    fixtureFacts,
    calibrationBatches,
  } = await import("../../online/benchmark/operator/questions.ts");
  const { bound, config, manifest } =
    await import("../../online/benchmark/operator/files.ts");
  const { gradeSeries, seriesRecord } =
    await import("../../online/benchmark/operator/series.ts");
  const { randomUUID } = await import("node:crypto");
  const m = manifest(config("examples/secretary-questions.json"));
  const sub = fs.mkdtempSync(path.join(repository, ".local", "series-edges-"));
  try {
    for (const width of [1, 2, 3, 4, 6, 8, 12]) {
      const windows = calibrationBatches(width);
      assert.equal(windows.length, 12);
      for (let pos = 0; pos < width; pos++)
        assert.equal(
          new Set(windows.map((w) => w.items[pos].question_id)).size,
          12,
        );
      if (width > 1)
        for (const [first, second] of [
          [1, 2],
          [3, 4],
        ]) {
          const ids = calibrationBatches(12)[0].items.map((i) => i.question_id);
          assert.ok(
            windows.some(
              (w) =>
                w.items.some((i) => i.question_id === ids[first]) &&
                w.items.some((i) => i.question_id === ids[second]),
            ),
          );
        }
    }
    const pc = calibrationBatches(12)[0],
      qualified = factResults(
        fixtureFacts(factPacket(pc.items), pc.key),
        factPacket(pc.items),
      );
    assert.deepEqual(
      qualified.reduce(
        (n, r) => ((n[r.verdict] = (n[r.verdict] ?? 0) + 1), n),
        {} as Record<string, number>,
      ),
      { PASS: 5, PARTIAL: 1, FAIL: 6 },
    );
    const item = itemFor(
      "one",
      "Which room?",
      {
        abstention: "NOT_ACCEPTABLE",
        required: ["Cedar"],
        forbidden: ["Elm is current"],
      },
      "Cedar and Elm are both current.",
    );
    const packet = factPacket([item]);
    const sample = {
      packet_sha256: bound(packet),
      results: [
        {
          question_id: "one",
          abstained: false,
          facts: [
            { id: "x1", reason: "Also asserts Elm", verdict: "ASSERTED" },
            { id: "r1", reason: "Cedar", verdict: "SUPPORTED" },
          ],
        },
      ],
    };
    assert.equal(
      factResults(JSON.stringify(sample), packet)[0].verdict,
      "FAIL",
    );
    for (const malformed of [
      { ...sample, packet_sha256: "incorrect" },
      { ...sample, results: [] },
      { ...sample, results: [sample.results[0], sample.results[0]] },
      {
        ...sample,
        results: [{ ...sample.results[0], question_id: "different" }],
      },
      {
        ...sample,
        results: [
          {
            ...sample.results[0],
            facts: [sample.results[0].facts[0], sample.results[0].facts[0]],
          },
        ],
      },
    ])
      assert.throws(() => factResults(JSON.stringify(malformed), packet));
    const events = (m.suite as any).timeline
      .slice(0, -1)
      .map((_: any, i: number) => ({
        sequence: i + 1,
        inputId: randomUUID(),
        messages: [
          { text: i === 1 ? "" : i === 4 ? "X".repeat(525000) : "OK" },
        ],
      }));
    const execution = { id: randomUUID(), manifest: m, events, partial: true };
    const plan = factPlan(execution);
    assert.deepEqual(plan.oversize, ["cedar-current"]);
    assert.equal(plan.batches.length, 0);
    await gradeSeries(sub, sub, "original", execution, async () => {
      throw Error("Unexpected dispatch");
    });
    const record = seriesRecord(
      execution,
      openSeal(path.join(sub, "grade.json")),
      { requests: [] },
      sub,
    );
    assert.equal(record.status, "INCOMPLETE");
    assert.deepEqual(
      record.questions.map((q: any) => [q.verdict, q.reason]),
      [
        ["MISSING", undefined],
        ["JUDGE_FAILED", "OVERSIZE"],
        ["NOT_EXECUTED", undefined],
      ],
    );
  } finally {
    fs.rmSync(sub, { recursive: true, force: true });
  }
});

test("the future-event and reference canaries stop outbound requests before transport", async () => {
  const { validateTimeline } =
    await import("../../online/benchmark/operator/questions.ts");
  const question = {
    type: "question",
    id: "first",
    text: "今天应该去哪里取件？",
    reference: {
      required: ["邮局"],
      forbidden: [],
      abstention: "NOT_ACCEPTABLE",
    },
  };
  assert.doesNotThrow(() =>
    validateTimeline([question, { ...question, id: "again" }]),
  );
  assert.throws(
    () => validateTimeline([{ ...question, text: "ok?" }]),
    /six letters/,
  );
  assert.throws(
    () =>
      validateTimeline([
        { type: "information", text: "上条提问是" + question.text },
        question,
      ]),
    /contained/,
  );
  const { gateway } =
    await import("../../online/benchmark/operator/transport.ts");
  const { save } = await import("../../online/benchmark/operator/files.ts");
  const f = fs.mkdtempSync(path.join(repository, ".local", "series-guard-"));
  try {
    for (const forbidden of [
      "Unasked future question",
      "host-only-reference-sentinel",
    ]) {
      const root = path.join(f, String(forbidden.length));
      save(path.join(root, "guard.json"), [
        "Unasked future question",
        "host-only-reference-sentinel",
      ]);
      let dispatched = 0;
      const gate = await gateway(
        root,
        { maxWireBytes: 524288 },
        new AbortController().signal,
        () => {
          dispatched++;
          return "";
        },
      );
      try {
        const r = await fetch(gate.url + "/chat/completions", {
          method: "POST",
          headers: {
            authorization: "Bearer " + gate.capability,
            "x-opencode-session": "fixture",
            "user-agent": "secretary-pi-demo/0.2",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ messages: [{ content: forbidden }] }),
        });
        assert.ok(!r.ok);
        assert.match(gate.firstFailure!, /Undelivered|canary/i);
        assert.equal(dispatched, 0);
      } finally {
        await gate.close();
      }
    }
  } finally {
    fs.rmSync(f, { recursive: true, force: true });
  }
});

test("series gateway protects short event text and resets the allowance only on the next event", async () => {
  const { gateway } =
    await import("../../online/benchmark/operator/transport.ts");
  const { writeJSON } = await import("../../online/benchmark/io.ts");
  const root = fs.mkdtempSync(
    path.join(repository, ".local", "series-gateway-"),
  );
  const body = (content: string) =>
    JSON.stringify({
      model: "deepseek-v4.1-flash",
      stream: true,
      max_tokens: 100,
      messages: [{ role: "user", content }],
    });
  try {
    for (const reason of ["allowance", "future"]) {
      const dir = path.join(root, reason);
      fs.mkdirSync(dir);
      let sent = 0;
      const gate = await gateway(
        dir,
        {
          maxWireBytes: 5000,
          maxOutput: 100,
          suite: { timeline: true },
          config: { workloadCallsPerEvent: 1 },
        },
        new AbortController().signal,
        () => {
          sent++;
          return "data: [DONE]\n\n";
        },
      );
      try {
        const post = (content: string) =>
          fetch(gate.url + "/chat/completions", {
            method: "POST",
            headers: {
              authorization: "Bearer " + gate.capability,
              "user-agent": "secretary-pi-demo/0.2",
              "x-opencode-session": "fixture",
            },
            body: body(content),
          });
        const guard = path.join(dir, "guard.json");
        writeJSON(guard, { sequence: 1, blocked: ["ABCDEF"] });
        assert.ok((await post("normal ABCDEF suffix")).ok);
        writeJSON(guard, { sequence: 2, blocked: ["ABCDEF"] });
        if (reason === "allowance")
          assert.ok((await post("allowed second event")).ok);
        assert.ok(
          !(await post(reason === "allowance" ? "over limit" : "ABCDEF")).ok,
        );
        assert.match(
          gate.firstFailure!,
          reason === "allowance" ? /allowance/ : /Undelivered/,
        );
        assert.equal(sent, reason === "allowance" ? 2 : 1);
      } finally {
        await gate.close();
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("record-only portable regrade binds to original execution, retains a failed packet and scores the rest", async () => {
  const { randomUUID } = await import("node:crypto");
  const { config, manifest, seal, save, bound } =
    await import("../../online/benchmark/operator/files.ts");
  const { sealPrefix } = await import("../../online/benchmark/operator/cli.ts");
  const { pack } = await import("../../online/benchmark/operator/bundle.ts");
  const { claim, remainingJudgeCalls } =
    await import("../../online/benchmark/operator/transport.ts");
  const { calibrationBatches, fixtureFacts, packetLimits } =
    await import("../../online/benchmark/operator/questions.ts");
  const { mockStream } =
    await import("../../online/benchmark/operator/grading.ts");
  const root = fs.mkdtempSync(
    path.join(repository, ".local", "series-portable-"),
  );
  const run = randomUUID(),
    source = path.join(root, run),
    bundle = path.join(root, "different-directory");
  const env = { ...process.env },
    realFetch = globalThis.fetch;
  let n = 0;
  let invalidQualification = false;
  let interruptReader = false;
  try {
    const c = config("examples/secretary-questions.json");
    c.questionsPerRequest = 1;
    const m: any = manifest(c);
    m.config = {
      ...m.config,
      workload: "opencode-go",
      judge: "hermes-go",
      billingPolicy: "record-only",
    };
    m.readerRelease = "simulated-native-reader";
    m.provider = "test fixture";
    seal(path.join(source, "manifest.json"), m);
    seal(path.join(source, "series-started.json"), {
      id: run,
      manifest: bound(m),
      at: Date.now(),
    });
    // The third question had no acknowledged observation when the controller stopped.
    for (const [i, event] of m.suite.timeline.slice(0, -1).entries()) {
      const input = { id: randomUUID(), sequence: i + 1, text: event.text };
      const observation = {
        id: input.id,
        sequence: i + 1,
        inputId: randomUUID(),
        messages: [{ text: "The recorded synthetic reply." }],
      };
      save(path.join(source, "events", i + ".input.json"), input);
      save(path.join(source, "events", i + ".observation.json"), observation);
      seal(path.join(source, "events", i + ".ack.json"), {
        sequence: i + 1,
        inputId: observation.inputId,
        input: bound(input),
        observation: bound(observation),
      });
    }
    sealPrefix(source, m);
    pack(source, bundle);
    fs.renameSync(source, source + "-hidden");
    const reader = path.join(root, "fixture-reader");
    fs.writeFileSync(
      reader,
      `#!/usr/bin/python3
import hashlib,json,sys,uuid
q=json.loads(sys.stdin.readline())["query"]
body=json.dumps(dict(model="deepseek-v4.1-flash",messages=[dict(role="user",content=q)],max_tokens=49152,reasoning_effort="max",stream=True,stream_options=dict(include_usage=True),thinking=dict(type="enabled")),ensure_ascii=False,separators=(",",":"))
h=hashlib.sha256(body.encode()).hexdigest(); s=str(uuid.uuid4())
print(json.dumps(dict(type="wire",sha256=h,body=body,session=s,userAgent="Hermes-fixture")),flush=True)
sse=json.loads(sys.stdin.readline())["sse"]
raw="".join(json.loads(line[6:])["choices"][0]["delta"].get("content","") for line in sse.splitlines() if line.startswith("data: {"))
if raw == "MISSING_NATIVE_RECEIPT": sys.exit(1)
print(json.dumps(dict(type="result",wire=h,session=s,raw=raw)),flush=True)
`,
      { mode: 0o700 },
    );
    Object.assign(process.env, {
      BENCHMARK_OPERATOR_ACCOUNT: path.join(root, "account"),
      BENCHMARK_HERMES_ROOT: root,
      BENCHMARK_HERMES_PYTHON: reader,
      SECRETARY_BENCHMARK_JUDGE_KEY: "judge-only-stub",
      BENCHMARK_DISABLE_TARGET: "1",
    });
    delete process.env.BENCHMARK_DISABLE_JUDGE;
    await claim(m, run);
    const spare = { ...m, config: { ...m.config, cohort: "other" } };
    await claim(spare, "other-run");
    const controls = calibrationBatches(1);
    const sessions = new Set<string>();
    globalThis.fetch = async (url, init) => {
      assert.ok(String(url).endsWith("/chat/completions"));
      assert.equal(init?.method, "POST");
      n++;
      const session = new Headers(init?.headers).get("x-opencode-session")!;
      assert.ok(!sessions.has(session));
      sessions.add(session);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.messages.length, 1);
      const query = body.messages[0].content;
      const packet = JSON.parse(query.slice(query.indexOf("\n{") + 1));
      assert.equal(
        Buffer.byteLength(String(init?.body)),
        packetLimits(packet.items).bytes,
      );
      const control = controls.find(
        (c) => c.items[0].question_id === packet.items[0].question_id,
      );
      // A malformed response in the first formal packet cannot select a retry.
      const raw =
        interruptReader && !control
          ? "MISSING_NATIVE_RECEIPT"
          : invalidQualification ||
              packet.items[0].question_id === "cedar-initial"
            ? "{}"
            : fixtureFacts(packet, control?.key);
      return new Response(mockStream(raw));
    };
    const diagnostic: any = await operatorCommand("regrade", [
      "--bundle",
      bundle,
    ]);
    const r = JSON.parse(fs.readFileSync(diagnostic.json, "utf8"));
    const { recoveredOutcomes } =
      await import("../../online/benchmark/operator/series.ts");
    const rows = recoveredOutcomes(
      openSeal(path.join(bundle, "execution.json")),
      path.join(bundle, "grades", diagnostic.grade),
    );
    assert.deepEqual(
      rows.map((row) => row.verdict),
      ["JUDGE_FAILED", "FAIL", "NOT_EXECUTED"],
    );
    assert.equal(rows[0].reason, r.questions[0].reason);
    assert.equal(
      rows[0].reason,
      "Fact response digest or question count mismatch",
    );
    assert.equal(r.grade, diagnostic.grade);
    assert.equal(r.canonical, false);
    assert.equal(r.status, "INCOMPLETE");
    assert.deepEqual(
      r.questions.map((q: any) => q.verdict),
      ["JUDGE_FAILED", "FAIL", "NOT_EXECUTED"],
    );
    assert.equal(r.claimHistory.claims.length, 2);
    assert.equal(
      r.claimHistory.claims.filter((c: any) => c.current)[0].run,
      run,
    );
    assert.equal(n, controls.length + 2);
    assert.equal(await remainingJudgeCalls(m, run), m.config.maxJudgeCalls - n);
    assert.equal(
      r.requests.every((x: any) => x.kind === "judge" && x.cash === null),
      true,
    );
    invalidQualification = true;
    const failed: any = await operatorCommand("regrade", ["--bundle", bundle]);
    const failedReport = JSON.parse(fs.readFileSync(failed.json, "utf8"));
    assert.deepEqual(
      failedReport.questions.map((q: any) => q.reason ?? q.verdict),
      ["CALIBRATION_FAILED", "CALIBRATION_FAILED", "NOT_EXECUTED"],
    );
    assert.equal(n, controls.length + 3);
    invalidQualification = false;
    interruptReader = true;
    const interrupted: any = await operatorCommand("regrade", [
      "--bundle",
      bundle,
    ]);
    const interruptedReport = JSON.parse(
      fs.readFileSync(interrupted.json, "utf8"),
    );
    assert.deepEqual(
      interruptedReport.questions.map((q: any) => q.verdict),
      ["JUDGE_FAILED", "JUDGE_FAILED", "NOT_EXECUTED"],
    );
    assert.match(interruptedReport.questions[1].reason, /receipt/i);
    const interruptedFolder = path.join(
      bundle,
      "grades",
      interrupted.grade,
      "packets/1",
    );
    assert.ok(
      fs.existsSync(path.join(interruptedFolder, "provider-content.json")),
    );
    assert.ok(!fs.existsSync(path.join(interruptedFolder, "response.json")));
    const moved = path.join(root, "copied-after-reader-failure");
    pack(bundle, moved);
    const crashCopy = path.join(root, "crash-after-provider-bytes");
    fs.cpSync(bundle, crashCopy, { recursive: true });
    const original = path.join(crashCopy, "grades/original");
    fs.cpSync(path.join(crashCopy, "grades", interrupted.grade), original, {
      recursive: true,
    });
    for (const name of [
      "grade.json",
      "accounting.json",
      "packets/1/attempt-failure.json",
      "packets/2",
    ])
      fs.rmSync(path.join(original, name), { recursive: true });
    const { sealInterruptedGrade } =
      await import("../../online/benchmark/operator/series.ts");
    sealInterruptedGrade(
      openSeal(path.join(crashCopy, "execution.json")),
      original,
    );
    assert.equal(
      openSeal(path.join(original, "grade.json")).outcomes[0].reason,
      "INTERRUPTED",
    );
    pack(crashCopy, path.join(root, "portable-interrupted-original"));
    process.env.BENCHMARK_DISABLE_JUDGE = "1";
    delete process.env.BENCHMARK_OPERATOR_ACCOUNT;
    const replay: any = await operatorCommand("report", [
      "--bundle",
      moved,
      "--grade",
      diagnostic.grade,
      "--output",
      path.join(root, "rebuilt"),
    ]);
    assert.deepEqual(
      fs.readFileSync(replay.json),
      fs.readFileSync(diagnostic.json),
    );
    assert.equal(n, controls.length * 2 + 5);
  } finally {
    globalThis.fetch = realFetch;
    for (const k of [
      "BENCHMARK_OPERATOR_ACCOUNT",
      "BENCHMARK_HERMES_ROOT",
      "BENCHMARK_HERMES_PYTHON",
      "SECRETARY_BENCHMARK_JUDGE_KEY",
      "BENCHMARK_DISABLE_TARGET",
      "BENCHMARK_DISABLE_JUDGE",
    ]) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  "CLI recovery preserves the original after loss of a target, controller or stop confirmation",
  { timeout: 150000 },
  async () => {
    const { spawn, execFileSync } = await import("node:child_process");
    const { setTimeout: delay } = await import("node:timers/promises");
    const { until } = await import("../../online/benchmark/io.ts");
    const scratch = fs.mkdtempSync(
      path.join(repository, ".local", "series-interrupt-"),
    );
    const c = JSON.parse(
      fs.readFileSync(
        path.join(repository, "examples/secretary-questions.json"),
        "utf8",
      ),
    );
    c.timeoutSeconds = 10;
    const configFile = path.join(scratch, "case.json");
    fs.writeFileSync(configFile, JSON.stringify(c));
    try {
      for (const mode of ["controller", "target", "supervisor"]) {
        const cli = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "test_case/online/benchmark/cli.ts",
            "evaluate",
            "--config",
            configFile,
          ],
          { cwd: repository, stdio: ["ignore", "ignore", "pipe"] },
        );
        const ended = new Promise((resolve) => cli.once("exit", resolve));
        let stderr = "";
        cli.stderr.on("data", (chunk) => (stderr += chunk));
        let runRoot: string | undefined;
        let suspended: number[] = [];
        try {
          await until(() => /Run [0-9a-f-]{36}/.test(stderr), 10000);
          const id = /Run ([0-9a-f-]{36})/.exec(stderr)![1];
          runRoot = rootFor(id);
          const ack = path.join(runRoot, "events/1.ack.json");
          const deadline = Date.now() + 25000;
          while (!fs.existsSync(ack) && Date.now() < deadline) await delay(3);
          assert.ok(fs.existsSync(ack));
          cli.kill("SIGSTOP");
          const group = openSeal(path.join(runRoot, "worker.json")).pgid;
          const members = execFileSync("ps", ["-axo", "pid=,pgid="], {
            encoding: "utf8",
          })
            .trim()
            .split("\n")
            .map((l) => l.trim().split(/\s+/).map(Number))
            .filter(([pid, pgid]) => pgid === group && pid !== group)
            .map(([pid]) => pid);
          assert.ok(members.length > 0);
          if (mode === "controller") cli.kill("SIGKILL");
          else {
            if (mode === "target")
              for (const pid of members) {
                try {
                  process.kill(pid, "SIGKILL");
                } catch (e: any) {
                  if (e.code !== "ESRCH") throw e;
                }
              }
            else {
              for (const pid of members) {
                try {
                  process.kill(pid, "SIGSTOP");
                  suspended.push(pid);
                } catch (e: any) {
                  if (e.code !== "ESRCH") throw e;
                }
              }
              process.kill(group, "SIGKILL");
            }
            cli.kill("SIGCONT");
          }
          await ended;
          if (mode === "supervisor") {
            assert.ok(!fs.existsSync(path.join(runRoot, "stopped.json")));
            assert.ok(!fs.existsSync(path.join(runRoot, "incomplete.json")));
            await assert.rejects(
              operatorCommand("recover-run", ["--run", id]),
              /group|owned target/i,
            );
            for (const pid of suspended) {
              try {
                process.kill(pid, "SIGKILL");
              } catch (e: any) {
                if (e.code !== "ESRCH") throw e;
              }
            }
            suspended = [];
          }
          if (mode === "controller" || mode === "supervisor") {
            await until(() => {
              try {
                process.kill(-group, 0);
                return false;
              } catch (e: any) {
                return e.code === "ESRCH";
              }
            }, 10000);
          }
          const result: any = await operatorCommand("recover-run", [
            "--run",
            id,
          ]);
          const report = JSON.parse(fs.readFileSync(result.json, "utf8"));
          assert.ok(report.canonical);
          assert.equal(report.status, "INCOMPLETE");
          assert.equal(report.coverage.planned, 3);
          assert.ok(report.coverage.graded >= 1 && report.coverage.graded < 3);
          assert.equal(report.coverage.executed, report.coverage.graded);
          const again: any = await operatorCommand("recover-run", [
            "--run",
            id,
          ]);
          assert.equal(again.grade, "original");
        } finally {
          if (cli.exitCode === null && cli.signalCode === null)
            cli.kill("SIGKILL");
          await ended;
          for (const pid of suspended) {
            try {
              process.kill(pid, "SIGKILL");
            } catch (e: any) {
              if (e.code !== "ESRCH") throw e;
            }
          }
          if (runRoot && fs.existsSync(path.join(runRoot, "stopped.json")))
            fs.rmSync(runRoot, { recursive: true, force: true });
        }
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test(
  "an unsuccessful live preflight leaves the same measurement claimable",
  { skip: process.platform !== "darwin" },
  async () => {
    const { config, manifest, bound } =
      await import("../../online/benchmark/operator/files.ts");
    const { claim, claimHistory } =
      await import("../../online/benchmark/operator/transport.ts");
    const { randomUUID } = await import("node:crypto");
    const scratch = fs.mkdtempSync(
      path.join(repository, ".local", "series-preclaim-"),
    );
    const env = { ...process.env };
    const bench = path.join(repository, ".local/benchmark");
    fs.mkdirSync(bench, { recursive: true });
    const before = new Set(fs.readdirSync(bench));
    const c = config("examples/secretary-questions.json");
    c.workload = "opencode-go";
    c.judge = "hermes-go";
    c.billingPolicy = "record-only";
    delete c.maxWorkloadCalls;
    const file = path.join(scratch, "case.json");
    fs.writeFileSync(file, JSON.stringify(c));
    try {
      process.env.BENCHMARK_HERMES_ROOT = path.join(scratch, "absent");
      process.env.BENCHMARK_HERMES_PYTHON = path.join(scratch, "absent/python");
      process.env.BENCHMARK_OPERATOR_ACCOUNT = path.join(scratch, "account");
      await assert.rejects(
        operatorCommand("evaluate", ["--config", file]),
        /venv missing/,
      );
      const owned = fs.readdirSync(bench).filter((name) => !before.has(name));
      assert.equal(owned.length, 1);
      const root = rootFor(owned[0]),
        m = manifest(config(file));
      assert.equal(
        openSeal(path.join(root, "incomplete.json")).coverage.executed,
        0,
      );
      assert.ok(!fs.existsSync(path.join(root, "transport")));
      assert.ok(!fs.existsSync(path.join(scratch, "account/claims")));
      const id = randomUUID();
      await claim(m, id);
      const fileOfClaim = path.join(
        scratch,
        "account/claims",
        bound(m) + ".json",
      );
      assert.ok(fs.existsSync(fileOfClaim));
      fs.writeFileSync(
        fileOfClaim,
        JSON.stringify({ digest: "invalid", run: id }),
      );
      await assert.rejects(claimHistory(m, id), /Invalid measurement claim/);
      fs.rmSync(root, { recursive: true, force: true });
    } finally {
      for (const k of [
        "BENCHMARK_HERMES_ROOT",
        "BENCHMARK_HERMES_PYTHON",
        "BENCHMARK_OPERATOR_ACCOUNT",
      ]) {
        if (env[k] === undefined) delete process.env[k];
        else process.env[k] = env[k];
      }
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test("recover-run publishes accepted original packet decisions without starting either endpoint", async () => {
  const scratch = fs.mkdtempSync(
    path.join(repository, ".local", "series-recover-grade-"),
  );
  const conf = JSON.parse(
    fs.readFileSync("examples/secretary-questions.json", "utf8"),
  );
  conf.target = "scripted-good";
  conf.questionsPerRequest = 1;
  const file = path.join(scratch, "case.json");
  fs.writeFileSync(file, JSON.stringify(conf));
  let root: string | undefined;
  const prior = { ...process.env };
  try {
    const first: any = await operatorCommand("evaluate", ["--config", file]);
    root = rootFor(first.run);
    const original = path.join(root, "grades/original");
    const expected = JSON.parse(fs.readFileSync(first.json, "utf8"))
      .questions[0];
    for (const name of [
      "grade.json",
      "accounting.json",
      "packets/2",
      "packets/3",
    ])
      fs.renameSync(
        path.join(original, name),
        path.join(scratch, name.replace("/", "-")),
      );
    fs.renameSync(path.join(root, "reports"), path.join(scratch, "reports"));
    process.env.BENCHMARK_DISABLE_JUDGE = "1";
    process.env.BENCHMARK_DISABLE_TARGET = "1";
    const result: any = await operatorCommand("recover-run", [
      "--run",
      first.run,
    ]);
    const recovered = JSON.parse(fs.readFileSync(result.json, "utf8"));
    assert.equal(recovered.canonical, true);
    assert.equal(recovered.coverage.graded, 1);
    assert.deepEqual(recovered.questions[0], expected);
    assert.deepEqual(
      recovered.questions.slice(1).map((q: any) => q.reason),
      ["UNSENT", "UNSENT"],
    );
    assert.deepEqual(recovered.requests, []);
    const bundle = path.join(scratch, "portable");
    await operatorCommand("export-run", [
      "--run",
      first.run,
      "--output",
      bundle,
    ]);
    const compared: any = await operatorCommand("compare", [
      "--run",
      first.run,
      "--reference",
      bundle,
    ]);
    assert.ok(
      compared.sameCase &&
        compared.samePrompt &&
        compared.questions.every((q: any) => q.sameReference),
    );
    const grade = openSeal(path.join(original, "grade.json"));
    grade.outcomes[0].verdict =
      grade.outcomes[0].verdict === "PASS" ? "FAIL" : "PASS";
    const { verifyFactGrade } =
      await import("../../online/benchmark/operator/series.ts");
    assert.throws(
      () =>
        verifyFactGrade(
          openSeal(path.join(root!, "execution.json")),
          grade,
          original,
        ),
      /verdict differs/,
    );
  } finally {
    for (const k of ["BENCHMARK_DISABLE_JUDGE", "BENCHMARK_DISABLE_TARGET"]) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
    if (root) fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
