import {
  ledger,
  loadCampaign,
  reserve,
} from "../../online/benchmark/campaign.ts";
import {
  physicalBound,
  reservationUSD,
} from "../../online/benchmark/stage-b-policy.ts";
import {
  completionJudge,
  completedBatchReport,
} from "../../online/benchmark/stage-c-grading.ts";
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
  { timeout: 1100000 },
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
            timeout: 870000,
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
    const started = command("start", ...approved);
    const first = f.batch[0].lane,
      episode = randomUUID(),
      policy = loadCampaign(root).physical_policy!;
    const active = {
      lane: first.lane,
      model: first.model,
      episode,
      run: episode,
      state: "OPEN",
      freeze_sha256: hash,
      deadline: Date.now() + 60000,
    };
    const dispatchFile = path.join(root, "campaign/stage-c-dispatch.json");
    writeJSON(dispatchFile, { ...started, current: first.lane });
    writeJSON(path.join(root, "campaign/active-stage-c.json"), active);
    const physical = physicalBound(policy, "deepseek-flash", 1000, 128, "main");
    const reserved = reservationUSD(
      policy.providers["deepseek-flash"],
      physical.input_bytes,
      physical.output_tokens,
    );
    const orphan = await reserve(root, {
      model: first.model,
      run: episode,
      episode,
      lane: first.lane,
      request_sha256: sha("in flight"),
      reserved_usd: reserved,
      physical,
    });

    const state = command("dispatch", ...approved);
    assert.equal(state.ended, true);
    assert.deepEqual(
      Object.values(state.terminals).map((r: any) => [
        r.status,
        r.reason ?? null,
      ]),
      [
        ["INCOMPLETE", "INTERRUPTED_TRAJECTORY"],
        ...Array(3).fill(["COMPLETED", null]),
      ],
    );
    const report = command("results", "--sha256", hash);
    assert.equal(report.physical_sends, 0);
    assert(report.metered_attempts > 10);
    assert.equal(report.rows.length, 5);
    const interrupted = ledger(root).entries.get(orphan)!;
    assert.equal(interrupted.outcome, "INTERRUPTED_IN_FLIGHT");
    assert.equal(interrupted.charged_usd, reserved);
    assert(report.rows.some((r: any) => r.spans_observed_identity_strata));
    const c16 = report.rows.find((r: any) => r.scenario === "C16-combined");
    assert.equal(c16.c16.gate, "OPEN");
    const natural = readJSON(
      path.join(
        root,
        "evidence",
        state.terminals[c16.source_lineage].run,
        "stage-c-trial.json",
      ),
    );
    const cold = natural.observations.find((o: any) => o.physical).physical
      .cold;
    assert.deepEqual(
      [
        cold.pre_restart.original_projection_exit,
        cold.probe.original_projection_exit,
      ],
      ["STILL_PRESENT", "STILL_PRESENT"],
    );
    // Local synthetic reader receipts exercise all branches without sending a packet to a model.
    const judge = { model: "Opus 5.5", effort: "Extra" },
      approval = completionApproval(hash, true);
    const reservation = await completionJudge(
      root,
      "begin",
      hash,
      approval,
      "calibration",
    );
    assert("packet_sha256" in reservation);
    const incomplete = await completionJudge(
      root,
      "finish",
      hash,
      approval,
      "calibration",
      {
        mechanical: "INVALID_JSON",
        evidence_sha256: sha("truncated JSON from synthetic reader"),
      },
    );
    assert("status" in incomplete && incomplete.status === "MECHANICAL");
    const prepare = await completionJudge(
      root,
      "begin",
      hash,
      approval,
      "calibration",
    );
    assert(
      "packet_sha256" in prepare &&
        prepare.packet_sha256 === reservation.packet_sha256 &&
        prepare.number === 2,
    );
    const key = readJSON(
      path.join(root, "oracles/completion/calibration/key.json"),
    );
    const calibrated = await completionJudge(
      root,
      "finish",
      hash,
      approval,
      "calibration",
      {
        judge,
        packet_sha256: "packet_sha256" in prepare ? prepare.packet_sha256 : "",
        labels: key.map((k: any) => ({ id: k.id, verdict: k.expected })),
      },
    );
    assert("status" in calibrated);
    assert.equal(calibrated.status, "PASSED");
    const lane = c16.source_lineage,
      terminal = state.terminals[lane];
    for (const [visibility, retention, verdict] of [
      ["RESIDENT", "PASS", "PASS"],
      ["COLD", "PASS", "FAIL"],
      ["RESIDENT", "FAIL", "FAIL"],
      ["OPAQUE", "PASS", "UNRESOLVED"],
      ["RESIDENT", "UNRESOLVED", "UNRESOLVED"],
    ]) {
      // Copy the necessary synthetic evidence into a separate owned test facility. Preserve the original trial and its grade store.
      const variant = path.join(
        repository,
        ".local/benchmark/tests",
        "reader-variant-" + randomUUID(),
      );
      const take = (rel: string) => {
        const dest = path.join(variant, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(path.join(root, rel), dest, { recursive: true });
      };
      for (const rel of [
        "configs/stage-c-freeze.json",
        "inputs",
        "reports/stage-c-projection.json",
        "campaign/attempts.jsonl",
        "campaign/stage-c-dispatch.json",
        "oracles",
      ])
        take(rel);
      const trialRel = "evidence/" + terminal.run + "/stage-c-trial.json";
      take(trialRel);
      const trialFile = path.join(variant, trialRel),
        trial = readJSON(trialFile);
      const observed = trial.observations.find((v: any) => v.physical);
      take(
        "evidence/" +
          observed.run +
          "/send-" +
          observed.physical.outcome.probe_send +
          ".json",
      );
      // This counterfactual has an exited original projection. The unmodified short rehearsal may retain it.
      for (const surface of [
        observed.physical.cold.pre_restart,
        observed.physical.cold.probe,
      ])
        surface.original_projection_exit = "SOURCE_EXIT";
      trial.synthetic_reader_fixture = true;
      trial.observations.find(
        (v: any) => v.mechanism === "HOST_PRODUCT_READ_LOG",
      ).result = retention;
      writeJSON(trialFile, trial);
      const stateCopy = structuredClone(state);
      stateCopy.terminals[lane].report_sha256 = sha(read(trialFile));
      // Other lane artifacts are outside this synthetic reader fixture.
      for (const [other, value] of Object.entries(stateCopy.terminals))
        if (other !== lane)
          stateCopy.terminals[other] = {
            status: "UNRUN",
            reason: "READER_FIXTURE",
          };
      writeJSON(
        path.join(variant, "campaign/stage-c-dispatch.json"),
        stateCopy,
      );
      const attempt = await completionJudge(
        variant,
        "begin",
        hash,
        approval,
        lane,
      );
      assert("packet" in attempt);
      const packet = attempt.packet;
      const accepted = await completionJudge(
        variant,
        "finish",
        hash,
        approval,
        lane,
        {
          judge,
          packet_sha256: attempt.packet_sha256,
          visibility,
          assertions: packet.assertions.map((a: string) => ({
            assertion: a,
            verdict: "PASS",
            rationale: "Synthetic grade for the reporting contract.",
            evidence: [packet.evidence[0].id],
          })),
        },
      );
      assert("status" in accepted);
      assert.equal(accepted.status, "ACCEPTED");
      const final = completedBatchReport(variant, hash).rows.find(
        (r) => r.scenario === "C16-combined",
      )!;
      assert.equal(final.c16?.verdict, verdict, JSON.stringify(final.c16));
      assert.equal(
        final.c16?.gate,
        verdict === "UNRESOLVED" ? "OPEN" : "CLOSED",
      );
    }
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
