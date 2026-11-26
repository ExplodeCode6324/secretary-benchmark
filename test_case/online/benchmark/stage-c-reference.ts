// Host-only diagnostic. Opening a product Store on preserved data can trigger recovery.
import path from "node:path";
import { readLog } from "../../../sut/secretary/src/pi_secretary/src/memory-search.ts";
import type {
  Stored,
  Store,
} from "../../../sut/secretary/src/pi_secretary/src/store.ts";
import { snapshot } from "./snapshot.ts";
import { cas, casBytes } from "./stage-b-scenarios-evidence.ts";
import type { ScenarioTrail } from "./stage-b-scenarios-protocol.ts";
import { read, requireThat, sha, writeJSON } from "./io.ts";
import type { Run } from "./domain.ts";
import { verifyDirectRecovery } from "./stage-c-recovery.ts";
import type { RestartEvidence } from "./baseline-evidence.ts";

type Capture = ReturnType<typeof snapshot>;
function lookup(core: string, capture: Capture, event: string) {
  const logs = capture.transactions.flatMap((t) => t.events);
  const store: Pick<Store, "logs" | "read" | "bytes" | "get"> = {
    logs,
    bytes: (ref) => casBytes(core, ref),
    read: (ref) => cas(core, ref),
    get: <T extends Stored>(type: T["record_type"], id: string) => {
      const found = capture.records.find(
        (r) => r.record_type === type && r.id === id,
      );
      requireThat(found && type === "Input", "C16_LOOKUP_RECORD");
      return found as T;
    },
  };
  // readLog's input branch uses only these four read operations.
  return readLog(store as Store, event);
}
export function bindOriginal(
  run: Run,
  input: ScenarioTrail["inputs"][number],
  original: string,
) {
  const core = path.join(run.active, "core");
  const state = snapshot(core);
  const events = state.transactions
    .flatMap((t) => t.events)
    .filter(
      (e) =>
        e.event_id === input.source_event && e.event_type === "input.accepted",
    );
  requireThat(events.length === 1, "C16_SOURCE_EVENT");
  const event = events[0],
    accepted = cas(core, event.payload);
  requireThat(
    accepted.producer === "MASTER" &&
      accepted.id === input.id &&
      accepted.session_id === event.scope.session_id &&
      input.text_sha256 === sha(original) &&
      casBytes(core, accepted.payload).equals(Buffer.from(original)),
    "C16_SOURCE_BINDING",
  );
  const found = lookup(core, state, event.event_id);
  requireThat(
    "body" in found &&
      found.kind === "input" &&
      found.body_hash === input.text_sha256,
    "C16_SOURCE_UNREADABLE",
  );
  return {
    run: run.id,
    lineage: run.lineage,
    domain: run.endpoint!.data_domain_id,
    input: input.id,
    event: event.event_id,
    session: accepted.session_id,
    original_sha256: input.text_sha256,
    pre_restart_journal: state.digest,
  };
}
export function inspectOriginal(
  old: Run,
  fresh: Run,
  restart: RestartEvidence,
  source: ReturnType<typeof bindOriginal>,
) {
  verifyDirectRecovery(old, fresh, source.domain, restart, read);
  requireThat(
    source.lineage === old.lineage && source.run === old.id,
    "C16_REFERENCE_DOMAIN",
  );
  const core = path.join(fresh.active, "core");
  const state = snapshot(core);
  // Record the final natural trial before performing any diagnostic lookup.
  const final = {
    run: fresh.id,
    lineage: fresh.lineage,
    domain: source.domain,
    final_journal: state.digest,
    source,
  };
  writeJSON(path.join(fresh.evidence, "stage-c-natural-end.json"), final);
  let result: "PASS" | "FAIL" | "UNRESOLVED" = "UNRESOLVED";
  let detail = "LOOKUP_INCONCLUSIVE";
  try {
    const found = lookup(core, state, source.event);
    if (
      "body" in found &&
      found.event_id === source.event &&
      found.scope?.session_id === source.session
    ) {
      result =
        found.kind === "input" && found.body_hash === source.original_sha256
          ? "PASS"
          : "FAIL";
      detail =
        result === "PASS"
          ? "ORIGINAL_HASH_VERIFIED"
          : "ORIGINAL_HASH_OR_KIND_CHANGED";
    }
  } catch (e) {
    if (e instanceof Error && e.message === "LOG_EVENT_NOT_FOUND") {
      result = "FAIL";
      detail = "ORIGINAL_EVENT_MISSING";
    }
  }
  const receipt = {
    ...final,
    result,
    detail,
    mechanism: "HOST_PRODUCT_READ_LOG" as const,
  };
  writeJSON(path.join(fresh.evidence, "stage-c-reference.json"), receipt);
  return receipt;
}
