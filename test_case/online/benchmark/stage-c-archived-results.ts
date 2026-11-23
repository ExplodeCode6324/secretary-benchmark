import path from "node:path";
import { read, readJSON, requireThat, sha, type FileEntry } from "./io.ts";
import { verifiedArchiveDigest, type ArchiveManifest } from "./archive.ts";

const digest = (v: unknown) =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);

// The caller supplies the configured archive destination. The portable index cannot choose an arbitrary manifest.
export function archivedBatch(
  destination: string,
  exportsRoot: string,
  b: any,
) {
  requireThat(
    digest(b.freeze_sha256) &&
      digest(b.archive_sha256) &&
      typeof b.archive_day === "string" &&
      /^\d{8}$/.test(b.archive_day) &&
      typeof b.archive_id === "string" &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(b.archive_id),
    "STAGE_C_AGGREGATE_INDEX",
  );
  const directory = path.join(destination, b.archive_day, b.archive_id);
  const receipt = readJSON(path.join(directory, "receipt.json"));
  const bytes = read(path.join(directory, "manifest.json"));
  const manifest: ArchiveManifest = JSON.parse(bytes.toString());
  requireThat(
    receipt.schema === "secretary-facility-archive-receipt-v1" &&
      [
        "ARCHIVED_SOURCE_REMOVED",
        "ARCHIVED_SOURCE_CLEANUP_INCOMPLETE",
        "VERIFIED_SOURCE_RETAINED",
      ].includes(receipt.state) &&
      receipt.archive_id === b.archive_id &&
      manifest.archive_id === b.archive_id &&
      receipt.manifest_sha256 === sha(bytes) &&
      receipt.archive_sha256 === b.archive_sha256 &&
      verifiedArchiveDigest(directory) === receipt.archive_sha256,
    "STAGE_C_AGGREGATE_ARCHIVE",
  );
  const entries = new Map(manifest.entries.map((e: FileEntry) => [e.path, e]));
  const dir = path.join(exportsRoot, b.freeze_sha256);
  function exported(name: string, archived: string) {
    const data = read(path.join(dir, name));
    const entry = entries.get(archived);
    requireThat(
      entry?.kind === "file" &&
        entry.sha256 === sha(data) &&
        entry.bytes === data.length,
      "STAGE_C_AGGREGATE_ARCHIVED_EXPORT",
    );
    return JSON.parse(data.toString());
  }
  const freeze = exported("stage-c-freeze.json", "configs/stage-c-freeze.json");
  requireThat(
    entries.get("configs/stage-c-freeze.json")?.sha256 === b.freeze_sha256,
    "STAGE_C_AGGREGATE_DIGEST",
  );
  const prefix = "oracles/completion/calibration/";
  requireThat(
    entries.get(prefix + "blind.json")?.sha256 === freeze.grade.packet_sha256,
    "STAGE_C_AGGREGATE_CALIBRATION",
  );
  const reservations = [1, 2, 3].filter((n) =>
    entries.has(prefix + "attempt-" + n + ".json"),
  );
  requireThat(
    reservations.every((n, i) => n === i + 1),
    "STAGE_C_AGGREGATE_CALIBRATION",
  );
  const attempt = reservations.length;
  const last = prefix + "attempt-" + attempt + "-result.json";
  const entry = entries.get(last);
  const result = entry ? exported("calibration-result.json", last) : undefined;
  const calibration = {
    attempts: attempt,
    status: result?.status ?? (attempt ? "RESERVED" : "NOT_TESTED"),
    receipt_sha256: entry?.sha256 ?? null,
    packet_sha256: freeze.grade.packet_sha256,
  };
  return {
    hash: b.freeze_sha256,
    archive_sha256: b.archive_sha256,
    freeze,
    projection: exported(
      "stage-c-projection.json",
      "reports/stage-c-projection.json",
    ),
    result: exported("stage-c-results.json", "reports/stage-c-results.json"),
    calibration,
    decisions: b.decisions,
  };
}
