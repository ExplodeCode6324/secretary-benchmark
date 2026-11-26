import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha } from "../../online/benchmark/io.ts";
import { verifyReaderPublications } from "../../online/benchmark/targeted-result.ts";

test("reader publications retain prior attempt identity, raw evidence and independent grades", () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "reader-publications-")),
  );
  function snapshot(
    sequence: number,
    prior: string | null,
    id: string,
    raw: string,
    settled = "a",
  ) {
    const report = {
      publication: { sequence, predecessor_sha256: prior },
      routes: {
        lost: {
          status: "UNRESOLVED",
          reason: "PENDING_RECONCILIATION",
          attempts: [{ attempt: id }],
        },
        independent: { status: "GRADED", selected_attempt: settled },
      },
    };
    const bytes = JSON.stringify(report) + "\n",
      digest = sha(bytes);
    const dir = path.join(root, "publications", digest);
    fs.mkdirSync(path.join(dir, "exchange/lost/attempts", id), {
      recursive: true,
    });
    fs.writeFileSync(path.join(dir, "series-final.json"), bytes);
    fs.writeFileSync(
      path.join(dir, "exchange/lost/attempts", id, "a-raw.txt"),
      raw,
    );
    return { dir, digest, report };
  }
  try {
    const first = snapshot(1, null, "a", "partial");
    const append = snapshot(2, first.digest, "a", "partial");
    verifyReaderPublications(append.dir, append.report);
    const redraw = snapshot(2, first.digest, "b", "partial");
    assert.throws(
      () => verifyReaderPublications(redraw.dir, redraw.report),
      /ATTEMPT_CHANGED/,
    );
    const overwrite = snapshot(3, append.digest, "a", "replacement");
    assert.throws(
      () => verifyReaderPublications(overwrite.dir, overwrite.report),
      /ATTEMPT_CHANGED/,
    );
    const otherGrade = snapshot(2, first.digest, "a", "partial", "new");
    assert.throws(
      () => verifyReaderPublications(otherGrade.dir, otherGrade.report),
      /GRADE_CHANGED/,
    );
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
