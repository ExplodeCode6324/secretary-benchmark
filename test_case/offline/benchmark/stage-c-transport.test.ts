import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fingerprint } from "../../online/benchmark/source.ts";
import {
  repository,
  readJSON,
  writeJSON,
  read,
  sha,
} from "../../online/benchmark/io.ts";
import { archiveFacility } from "../../online/benchmark/archive.ts";
import {
  completionApproval,
  freezeFile,
} from "../../online/benchmark/stage-c-freeze.ts";
import os from "node:os";

test(
  "completion CLI rehearses metered transport, shared source, C16 and sealed archive",
  { timeout: 600000 },
  async () => {
    const root = path.join(
      repository,
      ".local/benchmark/tests",
      "completion-sse-" + randomUUID(),
    );
    const fixture = new URL("./fixtures/stage-c/", import.meta.url);
    const command = (suffix: string, ...args: string[]) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "test_case/online/benchmark/cli.ts",
            "baseline-stage-c-" + suffix,
            "--root",
            root,
            ...args,
          ],
          {
            cwd: repository,
            encoding: "utf8",
            timeout: 450000,
            stdio: ["ignore", "pipe", "pipe"],
          },
        ),
      );
    const calibration = command("controls");
    const inputs = JSON.parse(
      fs.readFileSync(new URL("rehearsal-inputs.json", fixture), "utf8"),
    );
    fs.mkdirSync(path.join(root, "inputs/official"), { recursive: true });
    const price = path.join(root, "inputs/official/flash-pricing.md"),
      inputFile = path.join(root, "inputs/stage-c-preflight.json");
    fs.copyFileSync(new URL("rehearsal-rates.md", fixture), price);
    writeJSON(inputFile, { ...inputs, source: fingerprint(), calibration });
    const { hash } = command(
      "freeze",
      "--batch",
      "1",
      "--provenance",
      new Date().toISOString(),
    );
    const approved = [
      "--sha256",
      hash,
      "--approval",
      completionApproval(hash, true),
    ];
    const freeze = freezeFile(root),
      bytes = read(freeze),
      f = readJSON(freeze);
    const assertUnstarted = () =>
      assert(!fs.existsSync(path.join(root, "campaign/manifest.json")));
    for (const [file, change] of [
      [price, "price"],
      [inputFile, "inputs"],
      [freeze, "freeze"],
    ] as const) {
      const original = read(file);
      fs.appendFileSync(file, " ");
      try {
        assert.throws(() => command("start", ...approved));
        assertUnstarted();
      } finally {
        fs.writeFileSync(file, original);
      }
    }
    for (const target of ["source", "recipe", "models"]) {
      const changed = structuredClone(f);
      const origInputs = read(inputFile);
      if (target === "source") changed.source.source = sha("changed runner");
      if (target === "recipe") changed.batch[0].recipe.count++;
      if (target === "models") {
        const v = readJSON(inputFile);
        v.models.push("gpt-6-luna");
        writeJSON(inputFile, v);
        changed.inputs_sha256 = sha(read(inputFile));
      }
      writeJSON(freeze, changed);
      try {
        const h = sha(read(freeze));
        assert.throws(() =>
          command(
            "start",
            "--sha256",
            h,
            "--approval",
            completionApproval(h, true),
          ),
        );
        assertUnstarted();
      } finally {
        fs.writeFileSync(freeze, bytes);
        fs.writeFileSync(inputFile, origInputs);
      }
    }
    command("start", ...approved);
    const state = command("dispatch", ...approved);
    assert.equal(state.ended, true);
    assert.deepEqual(
      Object.values(state.terminals).map((r: any) => [
        r.status,
        r.reason ?? null,
      ]),
      Array(3).fill(["COMPLETED", null]),
    );
    const report = command("results", "--sha256", hash);
    assert.equal(report.physical_sends, 0);
    assert(report.metered_attempts > 10);
    assert.equal(report.rows.length, 4);
    assert(report.rows.some((r: any) => r.spans_observed_identity_strata));
    const c16 = report.rows.find((r: any) => r.scenario === "C16-combined");
    assert.equal(c16.c16.gate, "OPEN");
    const output = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "completion-sse-archive-")),
    );
    try {
      await archiveFacility(root, output);
    } finally {
      fs.rmSync(output, { recursive: true, force: true });
    }
  },
);
