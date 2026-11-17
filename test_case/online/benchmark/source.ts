import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { read, readJSON, noLinks, repository, requireThat, sha } from "./io.ts";

/** Verify the pinned read-only SUT, including recursive submodules. */
export function verifySut(base = repository) {
  const sut = path.join(base, "sut/secretary");
  noLinks(sut);
  const lock = readJSON(path.join(base, "sut.lock.json"));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  requireThat(
    lock.version === 1 &&
      /^[0-9a-f]{40}$/.test(lock.commit) &&
      lock.repository === "https://github.com/ExplodeCode6324/Secretary.git" &&
      lock.submodules &&
      Object.keys(lock.submodules).length > 0,
    "SUT_LOCK_INVALID",
  );
  requireThat(
    git(sut, "rev-parse", "HEAD") === lock.commit &&
      git(base, "ls-files", "--stage", "sut/secretary").startsWith(
        `160000 ${lock.commit} 0\t`,
      ),
    "SUT_PIN_MISMATCH",
  );
  requireThat(
    git(
      base,
      "config",
      "--file",
      ".gitmodules",
      "--get",
      "submodule.secretary.url",
    ) === lock.repository,
    "SUT_URL_MISMATCH",
  );
  requireThat(
    git(sut, "status", "--porcelain", "--untracked-files=all") === "",
    "SUT_MUST_BE_CLEAN",
  );
  const status = git(sut, "submodule", "status", "--recursive");
  const entries = status
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      requireThat(!/^[+U-]/.test(line), "SUT_SUBMODULE_PIN_MISMATCH");
      const [commit, name] = line.trim().split(/\s+/);
      noLinks(path.join(sut, name));
      requireThat(
        git(
          path.join(sut, name),
          "status",
          "--porcelain",
          "--untracked-files=all",
        ) === "",
        "SUT_SUBMODULE_MUST_BE_CLEAN",
      );
      return [name, commit];
    });
  const actual = Object.fromEntries(entries);
  requireThat(
    JSON.stringify(Object.entries(actual).sort()) ===
      JSON.stringify(Object.entries(lock.submodules).sort()),
    "SUT_SUBMODULE_PIN_MISMATCH",
  );
  return {
    commit: lock.commit,
    submodules: actual,
    lock_sha256: sha(read(path.join(base, "sut.lock.json"))),
  };
}

export function fingerprint() {
  const sut = verifySut();
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
    }).trim();
  const files = git(
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "sut.lock.json",
    ".gitmodules",
    "test_case/online/benchmark",
    "test_case/benchmarks/common",
    "package.json",
    "package-lock.json",
  )
    .split("\n")
    .filter(Boolean)
    .sort();
  const hashes = files
    .filter(
      (p) =>
        fs.existsSync(path.join(repository, p)) &&
        fs.statSync(path.join(repository, p)).isFile(),
    )
    .map((p) => [p, sha(read(path.join(repository, p)))]);
  return {
    sut,
    head: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    dirty: sha(
      git(
        "diff",
        "HEAD",
        "--",
        "sut.lock.json",
        ".gitmodules",
        "sut/secretary",
        "test_case",
        "package.json",
        "package-lock.json",
      ),
    ),
    source: sha(JSON.stringify(hashes)),
    lockfile: sha(read(path.join(repository, "package-lock.json"))),
    submodules: git("submodule", "status", "--recursive"),
    node: process.version,
  };
}
