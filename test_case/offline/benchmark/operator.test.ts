import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { operatorCommand } from "../../online/benchmark/operator/cli.ts";
import { rootFor, openSeal } from "../../online/benchmark/operator/files.ts";
import { sha, repository } from "../../online/benchmark/io.ts";

test("public historical coverage bytes remain reproducible", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "issue122-coverage-"));
  try {
    const file = path.join(temp, "coverage.json");
    execFileSync(
      "python3",
      [
        "scripts/export-issue122-coverage.py",
        "--retest",
        "evidence/issue122-targeted-retest.json",
        "--retest-sha256",
        "b362fe27edc09c4d6b1505219f3d86cefc86293e6a0809436780cf9a46d2a76e",
        "--output",
        file,
      ],
      { cwd: repository },
    );
    assert.equal(
      sha(fs.readFileSync(file)),
      "b96a85cb274f6c5c0bdf92422cd7c37334ca888d486938ed47bb88d74b0fb6f6",
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("operator runs isolated target, exports, regrades and renders independently", async () => {
  const parent = path.join(repository, ".local");
  fs.mkdirSync(parent, { recursive: true });
  const temp = fs.mkdtempSync(path.join(parent, "operator-test-"));
  const owned: string[] = [];
  try {
    const example = JSON.parse(
      fs.readFileSync(
        path.join(repository, "examples/secretary-smoke.json"),
        "utf8",
      ),
    );
    for (const [target, workload, expected] of [
      ["scripted-good", "fixture", "PASS"],
      ["scripted-bad", "fixture", "FAIL"],
      ["secretary", "wire-rehearsal", "PASS"],
    ]) {
      const file = path.join(temp, target + ".json");
      fs.writeFileSync(file, JSON.stringify({ ...example, target, workload }));
      const result: any = await operatorCommand("evaluate", ["--config", file]);
      const root = rootFor(result.run);
      owned.push(root);
      assert.equal(result.verdict, expected);
      const e = openSeal(path.join(root, "execution.json"));
      assert.equal(e.events.length, 2);
      assert.ok(e.events.every((row: any) => row.inputId));
      assert.equal(e.events[1].sequence, 2);
      if (workload === "wire-rehearsal") {
        assert.ok(JSON.stringify(e.firstProbeMessages).includes("REED-843"));
        assert.ok(fs.readdirSync(path.join(root, "mock-wires")).length >= 2);
        assert.equal(fs.existsSync(path.join(root, "transport")), false);
      }
      const bundle = path.join(temp, target + "-portable");
      await operatorCommand("export-run", [
        "--run",
        result.run,
        "--output",
        bundle,
      ]);
      fs.renameSync(root, root + "-hidden");
      owned[owned.length - 1] = root + "-hidden";
      process.env.BENCHMARK_DISABLE_TARGET = "1";
      try {
        assert.equal(fs.existsSync(path.join(bundle, "reports")), false);
        const regrade: any = await operatorCommand("regrade", [
          "--bundle",
          bundle,
        ]);
        assert.notEqual(regrade.grade, "original");
        assert.equal(regrade.verdict, expected);
        process.env.BENCHMARK_DISABLE_JUDGE = "1";
        const out = path.join(temp, target + "-replay");
        await operatorCommand("report", ["--bundle", bundle, "--output", out]);
        for (const file of ["report.md", "report.json"])
          assert.deepEqual(
            fs.readFileSync(path.join(out, file)),
            fs.readFileSync(path.join(root + "-hidden", "reports", file)),
          );
        await assert.rejects(
          operatorCommand("regrade", ["--bundle", bundle]),
          /Judge disabled/,
        );
        fs.appendFileSync(path.join(bundle, "execution.json"), " ");
        await assert.rejects(
          operatorCommand("report", ["--bundle", bundle]),
          /BUNDLE_MEMBER_CHANGED/,
        );
      } finally {
        delete process.env.BENCHMARK_DISABLE_TARGET;
        delete process.env.BENCHMARK_DISABLE_JUDGE;
      }
    }
  } finally {
    for (const root of owned) fs.rmSync(root, { force: true, recursive: true });
    fs.rmSync(temp, { force: true, recursive: true });
  }
});

test("Go reservations refuse excess calls and retain the first uncertain response", async () => {
  const { claim, send, reconcile } =
    await import("../../online/benchmark/operator/transport.ts");
  const dir = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "operator-meter-"),
  );
  const previous = process.env.BENCHMARK_OPERATOR_ACCOUNT,
    original = globalThis.fetch,
    oldKey = process.env.SECRETARY_BENCHMARK_GO_API_KEY;
  const root = path.join(dir, "execution");
  fs.mkdirSync(root);
  process.env.BENCHMARK_OPERATOR_ACCOUNT = path.join(dir, "account");
  process.env.SECRETARY_BENCHMARK_GO_API_KEY = "local-stub-token";
  const m = {
    config: { maxJudgeCalls: 5, maxWorkloadCalls: 1, timeoutSeconds: 15 },
    maxWireBytes: 524288,
    maxOutput: 49152,
  };
  const body = JSON.stringify({
    model: "deepseek-v4.1-flash",
    stream: true,
    max_tokens: 128,
    messages: [],
  });
  const window = {
    status: "ok",
    percent: 0,
    resetsAt: new Date(Date.now() + 600000).toISOString(),
  };
  let posts = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/usage"))
      return Response.json({
        usage: { rolling: window, weekly: window, monthly: window },
      });
    assert.equal(init?.method, "POST");
    posts++;
    return new Response("first failure body", {
      status: 503,
      headers: { "x-request-id": "fixture-request" },
    });
  };
  try {
    await claim(m, path.basename(root));
    await assert.rejects(claim(m, path.basename(root)), /EEXIST/);
    await assert.rejects(send(root, m, "workload", body), /HTTP 503/);
    await assert.rejects(
      send(root, m, "workload", body),
      /allowance exhausted/,
    );
    assert.equal(posts, 1);
    const transport = path.join(root, "transport");
    const raw = JSON.parse(
      fs.readFileSync(
        path.join(
          transport,
          fs.readdirSync(transport).find((n) => n.endsWith(".raw.json"))!,
        ),
        "utf8",
      ),
    );
    assert.deepEqual(
      [raw.status, raw.requestId, raw.body],
      [503, "fixture-request", "first failure body"],
    );
    const second = { ...m, cohort: "second" };
    const secondRoot = path.join(dir, "second");
    fs.mkdirSync(secondRoot);
    await claim(second, "second");
    await assert.rejects(
      send(secondRoot, second, "workload", body),
      /Uncertain provider send/,
    );
    assert.equal(posts, 1);
    const { bound, seal } =
      await import("../../online/benchmark/operator/files.ts");
    seal(path.join(root, "manifest.json"), m);
    const attempt = fs
      .readdirSync(transport)
      .find((n) => n.endsWith(".request.json"))!
      .split(".")[0];
    const statement = path.join(dir, "statement.json");
    fs.writeFileSync(
      statement,
      JSON.stringify({
        attempt,
        run: path.basename(root),
        freeze: bound(m),
        wireDigest: sha(body),
        disposition: "retain-full-ceiling",
        basis: "Fixture account owner reviewed the original simulated 503",
      }),
    );
    const hash = sha(fs.readFileSync(statement));
    await assert.rejects(
      reconcile(root, attempt, statement, "invalid"),
      /approved SHA/,
    );
    const disposition = await reconcile(root, attempt, statement, hash);
    assert.equal(disposition.originalFreezeClosed, true);
    assert.deepEqual(
      disposition,
      await reconcile(root, attempt, statement, hash),
    );
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith("/usage"))
        return Response.json({
          usage: { rolling: window, weekly: window, monthly: window },
        });
      assert.equal(init?.method, "POST");
      posts++;
      const frame = {
        model: "deepseek-v4.1-flash",
        choices: [
          { index: 0, delta: { content: "answer" }, finish_reason: "stop" },
        ],
        usage: {
          cost: 0,
          prompt_tokens: 1,
          completion_tokens: 1,
          opencode: { billing_source: "go", list_cost: 0.01 },
        },
      };
      return new Response(
        "data: " + JSON.stringify(frame) + "\n\ndata: [DONE]\n\n",
      );
    };
    assert.ok(
      (await send(secondRoot, second, "workload", body)).includes("answer"),
    );
    assert.equal(posts, 2);
  } finally {
    globalThis.fetch = original;
    if (previous === undefined) delete process.env.BENCHMARK_OPERATOR_ACCOUNT;
    else process.env.BENCHMARK_OPERATOR_ACCOUNT = previous;
    if (oldKey === undefined) delete process.env.SECRETARY_BENCHMARK_GO_API_KEY;
    else process.env.SECRETARY_BENCHMARK_GO_API_KEY = oldKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the fixed-prompt judge rejects a mislabelled control and false visibility citation", async () => {
  const { validateJudgeReply } =
    await import("../../online/benchmark/operator/grading.ts");
  const { targetedControls } =
    await import("../../online/benchmark/targeted-reader-packet.ts");
  const { bound } = await import("../../online/benchmark/operator/files.ts");
  const { packet, key } = targetedControls();
  const judge = {
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    reasoning_effort: "max",
  };
  const labels = key.map((r: any) => ({ id: r.id, verdict: r.expected }));
  const mark = { judge, packet_sha256: bound(packet), labels };
  assert.equal(
    validateJudgeReply(JSON.stringify(mark), packet, key).labels.length,
    28,
  );
  labels[0].verdict = "invalid";
  assert.throws(
    () => validateJudgeReply(JSON.stringify(mark), packet, key),
    /calibration failed/,
  );
  const evidence = {
    evidence: [{ id: "reply", text: "Observable reply: REED-843" }],
  };
  const invalid = {
    judge,
    packet_sha256: bound(evidence),
    visibility: "RESIDENT",
    visibility_evidence: ["reply"],
    assertions: [
      {
        assertion: "natural_access",
        verdict: "PASS",
        rationale: "Fixture",
        evidence: ["reply"],
      },
    ],
  };
  assert.throws(
    () => validateJudgeReply(JSON.stringify(invalid), evidence),
    /Visibility must cite/,
  );
});
