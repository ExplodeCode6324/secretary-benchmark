import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  deploymentGuard,
  repository,
  writeJSON,
} from "../../online/benchmark/io.ts";
import { archiveConfiguration } from "../../online/benchmark/archive.ts";
import { verifySut } from "../../online/benchmark/source.ts";

test("protected checkout rejects canonical, alias and case variants without writing there", () => {
  const protectedPath = path.join(os.homedir(), "Desktop/secretary-agile");
  for (const p of [
    protectedPath,
    protectedPath.toUpperCase(),
    protectedPath + "/child",
    ...(fs.existsSync(protectedPath) ? [fs.realpathSync(protectedPath)] : []),
  ])
    assert.throws(
      () => deploymentGuard(p),
      /PROTECTED_AGILE_CHECKOUT|SYMLINK_PATH/,
    );
  const dir = path.join(repository, ".local/reviews", "guard-" + randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(protectedPath, path.join(dir, "alias"));
  assert.throws(() => deploymentGuard(path.join(dir, "alias")), /SYMLINK_PATH/);
});

test("archive configuration has no default and rejects unsafe input", () => {
  const file = path.join(
    repository,
    ".local/reviews",
    "archive-config-" + randomUUID() + ".json",
  );
  assert.throws(
    () => archiveConfiguration(file),
    /ARCHIVE_CONFIGURATION_REQUIRED/,
  );
  for (const v of [
    {},
    { mount: "relative", destination: "relative/child" },
    { mount: "/", destination: "/archive" },
    { mount: "/mnt/volume", destination: "/elsewhere" },
    { mount: "/mnt/volume", destination: "/mnt/volume/archive", extra: true },
  ]) {
    writeJSON(file, v);
    assert.throws(
      () => archiveConfiguration(file),
      /ARCHIVE_CONFIGURATION_INVALID|NON_CANONICAL_PATH/,
    );
  }
  writeJSON(file, { mount: "/mnt/volume", destination: "/mnt/volume/archive" });
  assert.deepEqual(archiveConfiguration(file), {
    mount: "/mnt/volume",
    destination: "/mnt/volume/archive",
  });
  fs.chmodSync(file, 0o644);
  assert.throws(
    () => archiveConfiguration(file),
    /ARCHIVE_CONFIGURATION_PRIVATE_REQUIRED/,
  );
});

test("SUT pin rejects wrong identity, dirty source and uninitialized nested dependency", () => {
  assert.equal(verifySut().commit, "873b66f4b906ff53a62476ff5dd1466649c427f7");
  const base = path.join(
    repository,
    ".local/reviews",
    "sut-guard-" + randomUUID(),
  );
  fs.mkdirSync(path.join(base, "sut"), { recursive: true });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(base, "init", "-q");
  execFileSync(
    "git",
    [
      "clone",
      "--shared",
      "--no-checkout",
      path.join(repository, "sut/secretary"),
      path.join(base, "sut/secretary"),
    ],
    { stdio: "pipe" },
  );
  git(path.join(base, "sut/secretary"), "checkout", "-q", "HEAD");
  fs.copyFileSync(
    path.join(repository, ".gitmodules"),
    path.join(base, ".gitmodules"),
  );
  const lock = JSON.parse(
    fs.readFileSync(path.join(repository, "sut.lock.json"), "utf8"),
  );
  writeJSON(path.join(base, "sut.lock.json"), {
    ...lock,
    commit: "a".repeat(40),
  });
  git(base, "add", "sut/secretary");
  assert.throws(() => verifySut(base), /SUT_PIN_MISMATCH/);
  writeJSON(path.join(base, "sut.lock.json"), lock);
  fs.writeFileSync(path.join(base, "sut/secretary/untracked-test"), "fixture");
  assert.throws(() => verifySut(base), /SUT_MUST_BE_CLEAN/);
  fs.unlinkSync(path.join(base, "sut/secretary/untracked-test"));
  assert.throws(() => verifySut(base), /SUT_SUBMODULE_PIN_MISMATCH/);
});

test("standalone runtime never imports the historical harness", () => {
  for (const name of fs.readdirSync(
    path.join(repository, "test_case/online/benchmark"),
  )) {
    if (!name.endsWith(".ts")) continue;
    const text = fs.readFileSync(
      path.join(repository, "test_case/online/benchmark", name),
      "utf8",
    );
    assert(!/sut\/secretary\/test_case/.test(text), name);
    assert(!/\.\.\/\.\.\/\.\.\/src\//.test(text), name);
  }
});
