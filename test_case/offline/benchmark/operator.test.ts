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
            fs.readFileSync(path.join(bundle, "reports", file)),
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
