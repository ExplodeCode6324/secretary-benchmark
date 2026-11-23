import fs from "node:fs";
import path from "node:path";
import { processStatus, requireThat, sha, writeJSON, readJSON } from "./io.ts";

export function identityHash(identity: any) {
  requireThat(
    identity &&
      ["machine", "boot", "start", "token"].every(
        (k) => typeof identity[k] === "string" && identity[k],
      ) &&
      Number.isSafeInteger(identity.pid) &&
      identity.pid > 0,
    "PROCESS_WITNESS_IDENTITY",
  );
  return sha(
    JSON.stringify([
      identity.machine,
      identity.boot,
      identity.pid,
      identity.start,
      identity.token,
    ]),
  );
}
/** Host OS query, not a model assertion or stale registry RUNNING field. Never backfill old runs. */
export function captureProcessWitness(
  evidence: string,
  identity: any,
  expected: "RUNNING" | "STOPPED",
) {
  const observed = processStatus(identity);
  requireThat(observed === expected, "PROCESS_WITNESS_UNCONFIRMED");
  const hash = identityHash(identity);
  const file = path.join(evidence, `host-process-${hash}-${expected}.json`);
  if (!fs.existsSync(file))
    writeJSON(file, {
      schema: "benchmark-process-witness-v1",
      identity,
      identity_sha256: hash,
      observed,
      at: new Date().toISOString(),
      mechanism: "owned OS process probe",
    });
  else {
    const prior = readJSON(file);
    requireThat(
      prior.identity_sha256 === hash && prior.observed === expected,
      "PROCESS_WITNESS_CHANGED",
    );
  }
  return file;
}
