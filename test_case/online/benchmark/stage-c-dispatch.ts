import { isGoRehearsal } from "./stage-c-go-rehearsal.ts";
import { checkGoUsage } from "./stage-c-go-provider.ts";
import { rehearsalFetch, rehearsalKey } from "./stage-c-rehearsal.ts";
import {
  confirmedSystemFailure,
  identitySequence,
  boundModelBlock,
  resumableLaneFailure,
  externalInterruption,
  nextDispatchTime,
  providerRetryAt,
} from "./stage-c-continuation.ts";
import { setTimeout as delay } from "node:timers/promises";
import {
  continuationWorkload,
  retestWorkload,
  isRetest,
} from "./stage-c-targeted-policy.ts";
import { residualDefinition } from "./stage-c-go-residual.ts";
import {
  allGoReservationsSettled,
  localGoAmounts,
} from "./stage-c-go-local-usage.ts";
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
import {
  appendJSON,
  readJSON,
  writeJSON,
  requireThat,
  sha,
  read,
} from "./io.ts";

type Terminal = {
  status: "COMPLETED" | "INCOMPLETE" | "UNRUN";
  reason?: string;
  run?: string;
  report_sha256?: string;
  interruption?: { at: string; reason: string; id: string };
};
type State = {
  schema: string;
  freeze_sha256: string;
  started_at: string;
  ended: boolean;
  terminals: Record<string, Terminal>;
  history?: Record<string, Terminal[]>;
  pending?: Record<string, { run?: string; reason: string; retry_at: number }>;
  probes: Record<string, never>;
  repairs: Record<string, never>;
  current: string | null;
};
import {
  assertGoAvailable,
  claimGoFacility,
  closeGoFacility,
  checkGoHeadroom,
  holdGo,
} from "./stage-c-go-quota.ts";
import { checkGoProvider } from "./stage-c-go-provider.ts";
export async function completionCommand(
  root: string,
  mode: "start" | "dispatch" | "stop" | "first-contact",
  approval: string,
  hash: string,
) {
  // Validate the approved bytes and exact checkout before acquiring a lease, creating a facility or loading a credential.
  const { policy, batch, inputs } = loadCompletion(root, hash, approval);
  const stateFile = path.join(root, "campaign", "stage-c-dispatch.json"),
    activeFile = path.join(root, "campaign", "active-stage-c.json");
  const publication = () =>
    policy.providers["deepseek-flash"].route
      ? isGoRehearsal(root)
        ? checkGoUsage(
            rehearsalKey,
            rehearsalFetch(undefined, { mode: "NORMAL" }),
          )
        : checkGoProvider(policy.providers["deepseek-flash"], fetch, continuing)
      : checkPublication(
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
  const go = inputs.go_continuation;
  const targeted = Boolean(inputs.targeted_supplement);
  const usesGo = Boolean(go || targeted);
  const continuing =
    inputs.targeted_supplement?.series === continuationWorkload.series;
  const contact = "r1-C04-nonexistent--deepseek-flash";
  if (mode === "first-contact")
    requireThat(
      go?.partition === 5 && !residualDefinition(go),
      "GO_FIRST_CONTACT_SCOPE",
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
      if (usesGo)
        await claimGoFacility(
          root,
          hash,
          residualDefinition(go)?.freeze,
          targeted,
        );
      if (!continuing) await publication();
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
        ...(continuing ? { pending: {}, history: {} } : {}),
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
      let ownedRun: string | undefined;
      const dir = path.join(root, "runs");
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        const r = d.raw(f.replace(/\.json$/, ""));
        if (
          r.config.version === 5 &&
          r.config.lane === state.current &&
          !["RETIRED", "CLEANED"].includes(r.state)
        ) {
          const stopStarted = Date.now();
          await d.seal(r.id);
          if (continuing && r.endpoint && r.process) {
            appendJSON(
              path.join(root, "campaign", "stage-c-controller-stops.jsonl"),
              {
                run: r.id,
                domain: r.endpoint.data_domain_id,
                pid: r.process.pid,
                started: stopStarted,
                ended: Date.now(),
              },
            );
          }
          ownedRun = r.id;
        }
      }
      for (const [id, entry] of ledger(root).entries) {
        if (entry.attempt.lane === state.current && !entry.settled) {
          if (inputs.targeted_supplement?.series === retestWorkload.series)
            holdGo(hash, "GO_TARGETED_TRANSPORT_UNCERTAIN", root);
          await settle(root, id, "INTERRUPTED_IN_FLIGHT", null, null);
        }
      }
      state.terminals[state.current] = {
        status: "INCOMPLETE",
        reason: "INTERRUPTED_TRAJECTORY",
      };
      if (continuing) {
        const lane = state.current;
        const terminal = state.terminals[lane];
        terminal.run = ownedRun;
        (state.history![lane] ??= []).push(terminal);
        state.pending![lane] = {
          run: terminal.run,
          reason: "INTERRUPTED_TRAJECTORY",
          retry_at: Date.now() + 1000,
        };
        delete state.terminals[lane];
      }
      state.current = null;
      writeJSON(stateFile, state);
    }
    if (
      go &&
      mode === "dispatch" &&
      go.partition === 5 &&
      !residualDefinition(go)
    ) {
      const replay = readJSON(
        path.join(root, "reports/go-first-contact-replay.json"),
      );
      requireThat(
        state.terminals[contact]?.run &&
          replay.freeze === hash &&
          replay.lane === contact &&
          replay.sut === "PASS" &&
          replay.hermes === "PASS" &&
          /^[a-f0-9]{64}$/.test(replay.frames_sha256),
        "GO_FIRST_CONTACT_REPLAY_REQUIRED",
      );
    }
    do {
      if (mode === "dispatch" || mode === "first-contact")
        for (const row of batch.filter(
          (r) => mode !== "first-contact" || r.lane.lane === contact,
        )) {
          const l = row.lane;
          const pending = state.pending?.[l.lane];
          if (
            state.terminals[l.lane] ||
            (pending && Date.now() < pending.retry_at)
          )
            continue;
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
                "GO_SUBSCRIPTION_UNAVAILABLE",
                "GO_RATE_LIMIT",
              ].includes(e.outcome ?? ""),
          );
          if (held && !continuing) {
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
          let hold: string | undefined;
          if (!continuing && Date.now() + l.seconds * 1000 > until)
            hold = "BATCH_OR_SOURCE_WINDOW";
          else
            try {
              if (usesGo) {
                assertGoAvailable(
                  targeted ? { root, freeze: hash } : undefined,
                );
                const usage = await publication();
                if (!continuing)
                  checkGoHeadroom(usage, 0.7718592, localGoAmounts(root));
              } else await publication();
            } catch (error) {
              hold =
                error instanceof Error
                  ? error.message
                  : "PUBLICATION_UNAVAILABLE";
            }
          if (continuing && providerRetryAt(root) > Date.now())
            hold = "GO_PROVIDER_RETRY_AFTER";
          if (hold) {
            if (continuing) {
              appendJSON(path.join(root, "campaign", "facility-waits.jsonl"), {
                lane: l.lane,
                at: new Date().toISOString(),
                reason: hold,
                run: pending?.run,
              });
              state.pending![l.lane] = {
                reason: hold,
                retry_at: Math.max(Date.now() + 30000, providerRetryAt(root)),
                run: pending?.run,
              };
              writeJSON(stateFile, state);
              continue;
            }
            if (usesGo) holdGo(hash, hold, root);
            for (const remaining of batch)
              state.terminals[remaining.lane.lane] ??= {
                status: "UNRUN",
                reason: hold,
              };
            writeJSON(stateFile, state);
            break;
          }
          const desc = describeTrial(
            l.scenario,
            l.repeat,
            l.model,
            "BASELINE",
            row.recipe,
            row.task_recipe,
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
          if (isRetest(inputs.targeted_supplement?.series)) {
            const claim = path.join(
              root,
              "campaign",
              "retest-claims",
              l.lane + ".json",
            );
            if (continuing && pending && fs.existsSync(claim)) {
              const saved = readJSON(claim);
              requireThat(
                saved.freeze === hash &&
                  saved.lane === l.lane &&
                  saved.seed === l.seed,
                "RETEST_LANE_ALREADY_CLAIMED",
              );
            } else {
              requireThat(!fs.existsSync(claim), "RETEST_LANE_ALREADY_CLAIMED");
              writeJSON(claim, { freeze: hash, lane: l.lane, seed: l.seed });
            }
          }
          let r;
          try {
            r =
              continuing && pending?.run
                ? d.load(pending.run)
                : await d.create({
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
          } catch (error) {
            if (!continuing) throw error;
            const reason =
              error instanceof Error ? error.message : "DOMAIN_CREATE_FAILED";
            state.pending![l.lane] = {
              run: pending?.run,
              reason,
              retry_at: Date.now() + 30000,
            };
            appendJSON(path.join(root, "campaign", "facility-waits.jsonl"), {
              lane: l.lane,
              at: new Date().toISOString(),
              run: pending?.run,
              reason,
            });
            state.current = null;
            writeJSON(stateFile, state);
            continue;
          }
          const active = {
            state: "OPEN",
            episode: r.lineage,
            run: r.id,
            lane: l.lane,
            model: l.model,
            freeze_sha256: hash,
            ...(continuing
              ? { reviewed_identity_sequence: identitySequence(root, r.id) }
              : {}),
            deadline: continuing
              ? Date.now() + l.seconds * 1000
              : Math.min(Date.now() + l.seconds * 1000, until),
          };
          writeJSON(activeFile, active);
          const started = Date.now();
          try {
            const result = await executeTrial(d, r, desc, row);
            const failure = firstLaneFailure(
              [...ledger(root).entries.values()],
              l.lane,
            );
            let reason = continuing ? undefined : failure?.reason;
            if (inputs.targeted_supplement?.series === retestWorkload.series) {
              const report = readJSON(
                path.join(r.evidence, "stage-c-trial.json"),
              );
              const failed = report.observations.find(
                (o: any) => o.host_assisted && o.first_recovery_failure,
              );
              if (failed) reason ??= "RETEST_RECOVERY_INTERRUPTED";
              try {
                assertGoAvailable({ root, freeze: hash });
              } catch {
                reason ??= "RETEST_ACCOUNT_HELD";
              }
            }
            if (continuing) {
              const report = readJSON(
                path.join(r.evidence, "stage-c-trial.json"),
              );
              const special = report.observations.find(
                (o: any) => o.host_assisted && o.first_recovery_failure,
              );
              if (special) reason = String(special.first_recovery_failure);
            }
            state.terminals[l.lane] = {
              run: r.id,
              report_sha256: result.report_sha256,
              status: reason ? "INCOMPLETE" : "COMPLETED",
              ...(reason ? { reason } : {}),
            };
          } catch (e) {
            const file = path.join(r.evidence, "stage-c-trial.json");
            state.terminals[l.lane] = {
              run: r.id,
              status: "INCOMPLETE",
              reason: e instanceof Error ? e.message : "TRIAL_FAILED",
              ...(fs.existsSync(file)
                ? { report_sha256: sha(read(file)) }
                : {}),
            };
          } finally {
            if (
              inputs.targeted_supplement?.series === retestWorkload.series &&
              !allGoReservationsSettled(root, hash, ledger(root))
            ) {
              const reason = "GO_TARGETED_UNRESOLVED_AT_CLOSURE";
              holdGo(hash, reason, root);
              const terminal = state.terminals[l.lane];
              terminal.status = "INCOMPLETE";
              terminal.reason ??= reason;
            }
            if (continuing) {
              const terminal = state.terminals[l.lane],
                facility = externalInterruption(root, r, started);
              if (facility) terminal.interruption = facility;
              const system = confirmedSystemFailure(r);
              if (system) {
                await d.seal(r.id);
                terminal.status = "INCOMPLETE";
                terminal.reason = "CONFIRMED_SECRETARY_SYSTEM_FAILURE";
                writeJSON(
                  path.join(root, "campaign", "secretary-system-failure.json"),
                  { ...system, freeze_sha256: hash, lane: l.lane },
                );
                for (const next of batch) {
                  const lane = next.lane.lane;
                  const prior = state.pending?.[lane];
                  const file =
                    prior?.run &&
                    path.join(d.load(prior.run).evidence, "stage-c-trial.json");
                  state.terminals[lane] ??= prior?.run
                    ? {
                        status: "INCOMPLETE",
                        run: prior.run,
                        reason: prior.reason,
                        ...(file && fs.existsSync(file)
                          ? { report_sha256: sha(read(file)) }
                          : {}),
                      }
                    : { status: "UNRUN", reason: terminal.reason };
                }
                state.pending = {};
              } else if (
                terminal.status === "INCOMPLETE" &&
                resumableLaneFailure(
                  terminal.reason ?? "",
                  Boolean(boundModelBlock(root, r)),
                )
              ) {
                const original = terminal.reason ?? "TRIAL_FAILED";
                (state.history![l.lane] ??= []).push({
                  ...terminal,
                  reason: facility?.reason ?? original,
                });
                const report = path.join(r.evidence, "stage-c-trial.json");
                if (fs.existsSync(report)) {
                  const bytes = read(report);
                  fs.copyFileSync(
                    report,
                    path.join(root, "campaign", sha(bytes) + ".json"),
                  );
                }
                state.pending![l.lane] = {
                  run: r.id,
                  reason: facility?.reason ?? original,
                  retry_at: Math.max(
                    nextDispatchTime(r),
                    Date.now() +
                      Math.min(60000, 1000 * state.history![l.lane].length),
                  ),
                };
                delete state.terminals[l.lane];
              } else delete state.pending![l.lane];
            }
            writeJSON(activeFile, { ...active, state: "CLOSED" });
            state.current = null;
            writeJSON(stateFile, state);
          }
        }
      if (
        !continuing ||
        mode !== "dispatch" ||
        !Object.keys(state.pending ?? {}).length
      )
        break;
      await delay(
        Math.max(
          1,
          Math.min(
            60000,
            Math.min(...Object.values(state.pending!).map((p) => p.retry_at)) -
              Date.now(),
          ),
        ),
      );
    } while (true);
    if (mode === "first-contact") return state;
    for (const row of batch)
      state.terminals[row.lane.lane] ??= {
        status: "UNRUN",
        reason: "BATCH_STOPPED",
      };
    await d.closeStoppedCampaign();
    // An owned worker may have exited while its controller survived. A missing
    // settlement in either durable ledger also fences the independent reader.
    if (
      inputs.targeted_supplement?.series === retestWorkload.series &&
      !allGoReservationsSettled(root, hash, ledger(root))
    ) {
      holdGo(hash, "GO_TARGETED_UNRESOLVED_AT_CLOSURE", root);
    }
    if (usesGo) await closeGoFacility(root, hash);
    state.ended = true;
    writeJSON(stateFile, state);
    return state;
  });
}
