import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { operatorCommand } from "../../online/benchmark/operator/cli.ts";
import { rootFor, openSeal } from "../../online/benchmark/operator/files.ts";
import { repository } from "../../online/benchmark/io.ts";

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
        invalidQualification || packet.items[0].question_id === "cedar-initial"
          ? "{}"
          : fixtureFacts(packet, control?.key);
      return new Response(mockStream(raw));
    };
    const diagnostic: any = await operatorCommand("regrade", [
      "--bundle",
      bundle,
    ]);
    const r = JSON.parse(fs.readFileSync(diagnostic.json, "utf8"));
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
    process.env.BENCHMARK_DISABLE_JUDGE = "1";
    delete process.env.BENCHMARK_OPERATOR_ACCOUNT;
    const replay: any = await operatorCommand("report", [
      "--bundle",
      bundle,
      "--grade",
      diagnostic.grade,
      "--output",
      path.join(root, "rebuilt"),
    ]);
    assert.deepEqual(
      fs.readFileSync(replay.json),
      fs.readFileSync(diagnostic.json),
    );
    assert.equal(n, controls.length + 3);
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
