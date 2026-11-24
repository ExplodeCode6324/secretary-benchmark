// Run separately before the C16 freeze. Both scenarios use only in-memory provider streams.
import { assertCombinedRehearsal } from "./stage-c-combine-rehearsal.ts";
import { verifyPendingWorld } from "../../../online/benchmark/stage-c-pending-world.ts";
import {
  validateRestoredRecords,
  recoveryClass,
  snapshot,
} from "../../../online/benchmark/snapshot.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  readerPolicy,
  officialReader,
  visibilityV2,
} from "../../../online/benchmark/stage-c-visibility-rubric.ts";
import { sha } from "../../../online/benchmark/io.ts";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  prepareCompletionCalibration,
  completionJudge,
  completedBatchReport,
} from "../../../online/benchmark/stage-c-grading.ts";
import {
  completionApproval,
  freezeBatch,
} from "../../../online/benchmark/stage-c-freeze.ts";
import { completionCommand } from "../../../online/benchmark/stage-c-dispatch.ts";
import { fingerprint } from "../../../online/benchmark/source.ts";
import {
  repository,
  readJSON,
  writeJSON,
} from "../../../online/benchmark/io.ts";

for (const mode of ["ORIGINAL_OFFSET", "OTHER_EVENT"] as const) {
  test("C16 full recipe " + mode, { timeout: 1000000 }, async () => {
    const root = path.join(
      repository,
      ".local/benchmark/tests",
      "completion-cold-" + randomUUID(),
    );
    const dir = new URL("../fixtures/stage-c/", import.meta.url);
    const inputs = JSON.parse(
      fs.readFileSync(new URL("rehearsal-inputs.json", dir), "utf8"),
    );
    const calibration = await prepareCompletionCalibration(
      root,
      officialReader,
      visibilityV2,
    );
    fs.mkdirSync(path.join(root, "inputs/official"), { recursive: true });
    fs.copyFileSync(
      new URL("rehearsal-rates.md", dir),
      path.join(root, "inputs/official/flash-pricing.md"),
    );
    writeJSON(path.join(root, "inputs/stage-c-preflight.json"), {
      ...inputs,
      rehearsal_scenario: "C16-combined",
      rehearsal_read: mode,
      calibration,
      source: fingerprint(),
    });
    const { hash } = freezeBatch(root, 1, new Date().toISOString()),
      approval = completionApproval(hash, true);
    await completionCommand(root, "start", approval, hash);
    const state = await completionCommand(root, "dispatch", approval, hash);
    const [lane, terminal] = Object.entries(state.terminals)[0];
    assert.equal(terminal.status, "COMPLETED", terminal.reason);
    const trial = readJSON(
      path.join(root, "evidence", terminal.run!, "stage-c-trial.json"),
    );
    const observed = trial.observations.find((o: any) => o.physical),
      cold = observed.physical.cold;
    assert.deepEqual(
      [
        cold.pre_restart.original_projection_exit,
        cold.probe.original_projection_exit,
      ],
      ["SOURCE_EXIT", "SOURCE_EXIT"],
    );
    assert.equal(
      observed.witness.probe_chain.original_delivered,
      mode === "ORIGINAL_OFFSET",
    );
    const run = readJSON(path.join(root, "runs", terminal.run! + ".json")),
      journal = snapshot(path.join(run.active, "core"));
    const auths = journal.records.filter(
      (r) =>
        r.record_type === "AuthorizationRequest" &&
        r.action.action === "world.change",
    );
    assert.equal(auths.length, mode === "OTHER_EVENT" ? 2 : 1);
    for (const pending of auths) {
      assert(
        pending.record_type === "AuthorizationRequest" &&
          pending.state === "PENDING",
      );
      const op = journal.records.find(
        (r) => r.record_type === "Operation" && r.id === pending.operation_id,
      );
      assert(
        op?.record_type === "Operation" &&
          op.state === "WAIT_AUTH" &&
          op.effect === "NOT_STARTED" &&
          op.authorization_id === pending.id,
      );
      const rebound = journal.transactions.findIndex((tx) =>
        tx.events.some((e) => e.event_type === "operation.owner_rebound"),
      );
      assert(rebound >= 0, "the restarted worker rebinds ownership");
      const prefix = journal.transactions.slice(0, rebound);
      const history = journal.operationHistory.get(op.id)!;
      const original = history[0];
      assert.equal(history.length, 2);
      assert.equal(op.owner_epoch, original.owner_epoch + 1);
      assert.deepEqual(op, {
        ...original,
        owner_epoch: op.owner_epoch,
        updated_at: op.updated_at,
        revision: 2,
      });
      const proof = {
        history: new Map([[op.id, [original]]]),
        transactions: prefix,
        value: (ref: any) => readJSON(path.join(run.active, "core", ref.path)),
      };
      const domain = run.endpoint.data_domain_id;
      verifyPendingWorld(original, proof, domain);
      assert.throws(
        () => verifyPendingWorld(original, proof, "different-domain"),
        /AUTHORIZATION_UNPROVEN/,
      );
      for (const patch of [
        { state: "AUTHORIZED" },
        { state: "DISPATCHED" },
        { effect: "APPLIED" },
        { revision: 2 },
        { process: {} },
        { authorization_id: "different" },
      ])
        assert.throws(() =>
          verifyPendingWorld(
            { ...original, ...patch } as typeof original,
            proof,
            domain,
          ),
        );
      const withoutModel = {
        ...proof,
        transactions: prefix.map((tx) => ({
          ...tx,
          records: tx.records.filter((r) => r.record_type !== "ModelCall"),
        })),
      };
      assert.throws(
        () => verifyPendingWorld(original, withoutModel, domain),
        /MODEL_PROVENANCE/,
      );
      // C12b and checkpoint paths keep their original admission even in a mixed journal.
      const work = path.join(run.active, "core/workspaces"),
        owner = path.join(work, "offline-execution");
      const write = {
        ...original,
        id: "offline-write",
        scope: { ...original.scope, execution_id: "offline-execution" },
        state: "RESULT_UNKNOWN" as const,
        authorization_id: null,
        action: {
          ...original.action,
          action: "file.write",
          resource: path.join(owner, "result.txt"),
        },
      };
      const mixed = {
        ...proof,
        history: new Map([...proof.history, [write.id, [write]]]),
        transactions: [
          ...prefix,
          {
            events: [],
            records: [
              {
                record_type: "Execution",
                id: "offline-execution",
                workspace_binding: { root_path: owner },
              } as any,
            ],
          },
        ],
        value: (ref: any) =>
          ref === write.action.parameters_ref
            ? { path: "result.txt" }
            : proof.value(ref),
      };
      validateRestoredRecords([write], work, [], mixed);
      assert.throws(
        () => validateRestoredRecords([write, original], work, [], mixed),
        /UNSUPPORTED_OPERATION_STATE/,
      );
      assert.equal(recoveryClass("file.write", "RESULT_UNKNOWN"), "U");
    }
    assert(
      !journal.transactions.some((t) =>
        t.events.some(
          (e) =>
            e.event_type === "world.changed" &&
            auths.some(
              (a) =>
                a.record_type === "AuthorizationRequest" &&
                readJSON(path.join(run.active, "core", e.payload.path))
                  .batch_id === a.action.intent_id,
            ),
        ),
      ),
    );
    assert.equal(cold.restart_observed, true);
    assert.equal(trial.physical_provider_sends, 0);
    for (const observation of ["calibration", lane]) {
      const a = await completionJudge(
        root,
        "begin",
        hash,
        approval,
        observation,
      );
      assert("packet" in a);
      const content =
        observation === "calibration"
          ? {
              labels: readJSON(
                path.join(root, "oracles/completion/calibration/key.json"),
              ).map((k: any) => ({ id: k.id, verdict: k.expected })),
            }
          : {
              visibility: "COLD",
              visibility_evidence: [
                a.packet.evidence.find((r: any) =>
                  r.text.startsWith(
                    "First eligible request capture coverage\n",
                  ),
                ).id,
              ],
              assertions: a.packet.assertions.map((assertion: string) => ({
                assertion,
                verdict: "PASS",
                rationale: "Offline test of reader binding.",
                evidence: [a.packet.evidence[0].id],
              })),
            };
      assert("query" in a && typeof a.query === "string");
      const raw = JSON.stringify({
        ...content,
        judge: {
          provider: readerPolicy.provider,
          model: readerPolicy.model,
          reasoning_effort: readerPolicy.reasoning_effort,
        },
        packet_sha256: a.packet_sha256,
      });
      const dispatch = {
        decision_sha256: hash,
        wire_sha256: sha("offline-only native envelope " + a.query),
      };
      const envelope = {
        raw,
        dispatch,
        transport: {
          ...readerPolicy,
          ...dispatch,
          native_entry: "AIAgent.run_conversation",
          input_sha256: sha(a.query),
          raw_sha256: sha(raw),
          max_tokens: readerPolicy.max_output_tokens,
          wire_bytes: Buffer.byteLength(a.query) + 700,
          returned_model: readerPolicy.model,
          tools: 0,
          fallback: false,
          inference_dispatches: 1,
          http_status: 200,
          finish_reason: "stop",
          usage: {
            prompt_tokens: 10,
            prompt_cache_hit_tokens: 0,
            prompt_cache_miss_tokens: 10,
            completion_tokens: 10,
          },
          created: "2026-11-24T16:00:00Z",
          finished: "2026-11-24T16:00:01Z",
          calculated_charge_usd: 0.0000075,
        },
      };
      const response = await completionJudge(
        root,
        "finish",
        hash,
        approval,
        observation,
        envelope,
      );
      assert.equal(
        response.status,
        observation === "calibration" ? "PASSED" : "ACCEPTED",
      );
    }
    const report = completedBatchReport(root, hash);
    const combined = assertCombinedRehearsal(root, hash, report);
    assert.equal(combined.c16_closed, 1);
    assert.equal(report.physical_sends, 0);
    assert.equal(report.rows[0].c16?.gate, "CLOSED");
    assert.equal(
      report.rows[0].c16?.verdict,
      mode === "ORIGINAL_OFFSET" ? "PASS" : "FAIL",
    );
  });
}
