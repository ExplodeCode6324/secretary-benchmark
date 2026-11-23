import fs from "node:fs";
import path from "node:path";
import { Domains } from "./domain.ts";
import { createCampaign, ledger, loadCampaign, settle } from "./campaign.ts";
import { loadCompletion, officialFlash, freezeFile } from "./stage-c-freeze.ts";
import { describeTrial } from "./stage-c-plan.ts";
import { executeTrial } from "./stage-c-trial.ts";
import { checkAdmission } from "./stage-b-policy.ts";
import { firstLaneFailure } from "./stage-b-dispatch.ts";
import { checkPublication } from "./stage-b-freeze.ts";
import { readJSON, writeJSON, requireThat, sha, read } from "./io.ts";

type Terminal = {
  status: "COMPLETED" | "INCOMPLETE" | "UNRUN";
  reason?: string;
  run?: string;
  report_sha256?: string;
};
type State = {
  schema: string;
  freeze_sha256: string;
  started_at: string;
  ended: boolean;
  terminals: Record<string, Terminal>;
  probes: Record<string, never>;
  repairs: Record<string, never>;
  current: string | null;
};
export async function completionCommand(
  root: string,
  mode: "start" | "dispatch" | "stop",
  approval: string,
  hash: string,
) {
  // Validate the approved bytes and exact checkout before acquiring a lease, creating a facility or loading a credential.
  const { policy, batch, inputs } = loadCompletion(root, hash, approval);
  const stateFile = path.join(root, "campaign", "stage-c-dispatch.json"),
    activeFile = path.join(root, "campaign", "active-stage-c.json");
  const publication = () =>
    checkPublication(
      [
        {
          url: officialFlash,
          sha256: policy.providers["deepseek-flash"].provenance_sha256,
        },
      ],
      "rehearsal" in policy && policy.rehearsal
        ? async () =>
            new Response(
              read(
                path.join(root, "inputs/official/flash-pricing.md"),
              ).toString(),
            )
        : fetch,
    );
  return Domains.use(root, async (d) => {
    if (mode === "start") {
      requireThat(
        !fs.existsSync(stateFile) &&
          !fs.existsSync(path.join(root, "campaign", "manifest.json")),
        "STAGE_C_ALREADY_STARTED",
      );
      for (const row of batch)
        checkAdmission(
          policy,
          [],
          row.lane.lane,
          row.lane.model,
          "preflight",
          Date.now(),
        );
      await publication();
      await createCampaign(root, approval, undefined, undefined, policy);
      const state: State = {
        schema: "issue122-completion-dispatch-v1",
        freeze_sha256: hash,
        started_at: new Date().toISOString(),
        ended: false,
        terminals: {},
        probes: {},
        repairs: {},
        current: null,
      };
      writeJSON(stateFile, state);
      return state;
    }
    const state = readJSON<State>(stateFile),
      campaign = loadCampaign(root);
    requireThat(
      state.schema === "issue122-completion-dispatch-v1" &&
        state.freeze_sha256 === hash &&
        campaign.approval_id === approval &&
        campaign.physical_policy?.freeze_sha256 === hash,
      "STAGE_C_APPROVAL_BINDING",
    );
    if (state.ended) return state;
    if (state.current) {
      // A controller crash spent this trajectory. Preserve and seal the previously admitted incarnation, including a restored branch if one exists.
      const active = fs.existsSync(activeFile) ? readJSON(activeFile) : null;
      if (active?.state === "OPEN")
        writeJSON(activeFile, { ...active, state: "CLOSED" });
      const dir = path.join(root, "runs");
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        const r = d.raw(f.replace(/\.json$/, ""));
        if (
          r.config.version === 5 &&
          r.config.lane === state.current &&
          !["RETIRED", "CLEANED"].includes(r.state)
        )
          await d.seal(r.id);
      }
      for (const [id, entry] of ledger(root).entries) {
        if (entry.attempt.lane === state.current && !entry.settled)
          await settle(root, id, "INTERRUPTED_IN_FLIGHT", null, null);
      }
      state.terminals[state.current] = {
        status: "INCOMPLETE",
        reason: "INTERRUPTED_TRAJECTORY",
      };
      state.current = null;
      writeJSON(stateFile, state);
    }
    if (mode === "dispatch")
      for (const row of batch) {
        const l = row.lane;
        if (state.terminals[l.lane]) continue;
        const record = ledger(root);
        const held = [...record.entries.values()].find(
          (e) =>
            !e.settled ||
            e.component_violation ||
            e.bound_violation ||
            [
              "PROVENANCE_CHANGE",
              "VERSION_TRANSITION",
              "IDENTITY_UNKNOWN",
              "IDENTITY_MISMATCH_FIRST_CONTACT",
              "AUTH",
              "EXHAUSTED_QUOTA",
            ].includes(e.outcome ?? ""),
        );
        if (held) {
          const reason =
            held.component_violation || held.bound_violation
              ? "RESERVATION_BOUND"
              : (held.outcome ?? "UNSETTLED");
          for (const next of batch)
            state.terminals[next.lane.lane] ??= {
              status: "UNRUN",
              reason: "HOLD_" + reason,
            };
          writeJSON(stateFile, state);
          break;
        }
        const until = Math.min(
          Date.parse(state.started_at) + policy.batch_seconds * 1000,
          Date.parse(policy.providers[l.model].checked_at) + 86400000,
        );
        requireThat(
          Date.now() + l.seconds * 1000 <= until,
          "STAGE_C_BATCH_OR_SOURCE_WINDOW",
        );
        await publication();
        const desc = describeTrial(
          l.scenario,
          l.repeat,
          l.model,
          "BASELINE",
          row.recipe,
        );
        requireThat(
          inputs.models.includes(l.model) &&
            desc.external_inputs_sha256 === row.trial.inputs &&
            desc.recipe_sha256 === row.trial.timeline &&
            desc.seed === l.seed &&
            desc.profile === l.profile,
          "STAGE_C_RECIPE_DRIFT",
        );
        state.current = l.lane;
        writeJSON(stateFile, state);
        const r = await d.create({
          version: 5,
          mode: "live",
          track: "issue122",
          case_id: l.scenario,
          seed: l.seed,
          model: l.model,
          profile: l.profile,
          max_sends: l.cap,
          lane: l.lane,
          freeze_sha256: hash,
        });
        const active = {
          state: "OPEN",
          episode: r.lineage,
          run: r.id,
          lane: l.lane,
          model: l.model,
          freeze_sha256: hash,
          deadline: Math.min(Date.now() + l.seconds * 1000, until),
        };
        writeJSON(activeFile, active);
        try {
          const result = await executeTrial(d, r, desc, row);
          const failure = firstLaneFailure(
            [...ledger(root).entries.values()],
            l.lane,
          );
          state.terminals[l.lane] = {
            run: r.id,
            report_sha256: result.report_sha256,
            status: failure ? "INCOMPLETE" : "COMPLETED",
            ...(failure ? { reason: failure.reason } : {}),
          };
        } catch (e) {
          const file = path.join(r.evidence, "stage-c-trial.json");
          state.terminals[l.lane] = {
            run: r.id,
            status: "INCOMPLETE",
            reason: e instanceof Error ? e.message : "TRIAL_FAILED",
            ...(fs.existsSync(file) ? { report_sha256: sha(read(file)) } : {}),
          };
        } finally {
          writeJSON(activeFile, { ...active, state: "CLOSED" });
          state.current = null;
          writeJSON(stateFile, state);
        }
      }
    for (const row of batch)
      state.terminals[row.lane.lane] ??= {
        status: "UNRUN",
        reason: "BATCH_STOPPED",
      };
    await d.closeStoppedCampaign();
    state.ended = true;
    writeJSON(stateFile, state);
    return state;
  });
}
