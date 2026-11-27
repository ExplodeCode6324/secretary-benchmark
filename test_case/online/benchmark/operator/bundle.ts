import fs from "node:fs";
import path from "node:path";
import { noLinks, requireThat, inside, sha } from "../io.ts";
import { dir, openSeal, put, seal, load } from "./files.ts";

// The execution envelope contains every observation and the first probe wire.
// Include the source inputs and receipts so a portable copy can also be audited.
const components = [
  "manifest.json",
  "execution.json",
  "incomplete.json",
  "route.json",
  "mock-wires",
  "events",
  "transport",
  "calibration.json",
  "calibrations",
  "grades",
  "failures",
];
function entries(root: string) {
  const files: string[] = [];
  function visit(relative: string) {
    const p = path.join(root, relative);
    noLinks(p);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p).sort()) {
        if (name === "reader-home" || name === "reader.stderr") continue;
        visit(path.join(relative, name));
      }
    } else {
      requireThat(st.isFile(), "Unexpected evidence member");
      files.push(relative);
    }
  }
  for (const name of components)
    if (fs.existsSync(path.join(root, name))) visit(name);
  return files;
}
export function pack(root: string, out: string) {
  noLinks(out);
  requireThat(
    !fs.existsSync(out) && !inside(root, out),
    "Choose a new output outside the run",
  );
  const execution = openSeal(path.join(root, "execution.json"));
  requireThat(
    JSON.stringify(execution.manifest) ===
      JSON.stringify(openSeal(path.join(root, "manifest.json"))),
    "Manifest mismatch",
  );
  dir(out);
  const members: Record<string, string> = {};
  for (const file of entries(root)) {
    const data = fs.readFileSync(path.join(root, file));
    put(path.join(out, file), data);
    members[file] = sha(data);
  }
  seal(path.join(out, "bundle.json"), { run: execution.id, members });
  verifyBundle(out);
  return {
    bundle: out,
    run: execution.id,
    files: Object.keys(members).length,
    sha256: sha(fs.readFileSync(path.join(out, "bundle.json"))),
  };
}
export function verifyBundle(root: string) {
  const index = openSeal(path.join(root, "bundle.json"));
  for (const [name, hash] of Object.entries(index.members)) {
    const p = path.resolve(root, name);
    requireThat(inside(root, p), "Invalid bundle member");
    noLinks(p);
    requireThat(
      sha(fs.readFileSync(p)) === hash,
      "BUNDLE_MEMBER_CHANGED: " + name,
    );
  }
  const e = openSeal(path.join(root, "execution.json"));
  requireThat(
    e.id === index.run &&
      JSON.stringify(e.manifest) ===
        JSON.stringify(openSeal(path.join(root, "manifest.json"))),
    "Bundle identity mismatch",
  );
  for (const [i, event] of e.events.entries()) {
    requireThat(
      JSON.stringify(
        load(path.join(root, "events", i + ".observation.json")),
      ) === JSON.stringify(event),
      "Event trace mismatch",
    );
    const input = load(path.join(root, "events", i + ".input.json"));
    requireThat(
      input.id === event.id &&
        input.sequence === i + 1 &&
        input.text === [...e.manifest.suite.setup, e.manifest.suite.probe][i],
      "Event input mismatch",
    );
  }
  return e;
}
