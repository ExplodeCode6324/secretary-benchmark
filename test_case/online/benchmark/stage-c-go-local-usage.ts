import fs from "node:fs";
import path from "node:path";
import { mkdir, readJSON, writeJSON, repository, requireThat } from "./io.ts";

export const goAccount = path.join(
  repository,
  ".local/benchmark/.issue122-go-account",
);
export const goWindows = { rolling: 20, weekly: 50, monthly: 100 } as const;
export type Window = keyof typeof goWindows;
export type LocalAmounts = Record<Window, number>;
type Reservation = {
  freeze: string;
  amount: number;
  settled: boolean;
  expires: LocalAmounts;
};
const names = Object.keys(goWindows) as Window[];
const amounts = (fn: (k: Window) => number): LocalAmounts => ({
  rolling: fn("rolling"),
  weekly: fn("weekly"),
  monthly: fn("monthly"),
});
function directory(root: string) {
  return root.startsWith(
    path.join(repository, ".local/benchmark/tests") + path.sep,
  )
    ? path.join(root, "campaign/go-usage")
    : path.join(goAccount, "usage-reservations");
}
function entry(root: string, id: string) {
  requireThat(/^[a-zA-Z0-9-]{1,120}$/.test(id), "GO_LOCAL_RESERVATION_ID");
  return path.join(directory(root), id + ".json");
}
export function hasGoReservation(root: string, id: string) {
  return fs.existsSync(entry(root, id));
}
// The Go API does not identify the last request included in its percentage.
// Within each window count local consumption on top of the reported meter.
export function localGoAmounts(
  root: string,
  now = Date.now(),
  inspect?: (id: string, reservation: Readonly<Reservation>) => void,
) {
  const dir = directory(root),
    result = amounts(() => 0);
  if (!fs.existsSync(dir)) return result;
  for (const filename of fs.readdirSync(dir)) {
    if (!filename.endsWith(".json")) continue;
    const r = readJSON<Reservation>(path.join(dir, filename));
    inspect?.(filename.slice(0, -5), r);
    for (const k of names) {
      requireThat(
        Number.isFinite(r.amount) &&
          r.amount >= 0 &&
          Number.isFinite(r.expires[k]),
        "GO_LOCAL_METER_INVALID",
      );
      if (!r.settled || now < r.expires[k]) result[k] += r.amount;
    }
  }
  return result;
}
export function recordGoReservation(
  root: string,
  id: string,
  freeze: string,
  amount: number,
  usage: any,
) {
  const f = entry(root, id);
  requireThat(
    !fs.existsSync(f) && Number.isFinite(amount) && amount >= 0,
    "GO_LOCAL_RESERVATION_CONFLICT",
  );
  const expires = amounts((k) => Date.parse(usage[k].resetsAt));
  requireThat(
    names.every((k) => Number.isFinite(expires[k])),
    "GO_LOCAL_WINDOW_INVALID",
  );
  mkdir(directory(root));
  writeJSON(f, { freeze, amount, expires, settled: false });
}
export function settleGoReservation(
  root: string,
  id: string,
  actual: number | null,
) {
  const f = entry(root, id);
  if (!fs.existsSync(f)) return;
  const r = readJSON<Reservation>(f),
    now = Date.now();
  const amount = actual === null ? r.amount : actual;
  requireThat(Number.isFinite(amount) && amount >= 0, "GO_LOCAL_USAGE_INVALID");
  // A completion straddling a reset might have counted in the new window.
  const lifetime = {
    rolling: 5 * 3600e3,
    weekly: 7 * 86400e3,
    monthly: 31 * 86400e3,
  };
  for (const k of names)
    if (now >= r.expires[k]) r.expires[k] = now + lifetime[k];
  writeJSON(f, { ...r, amount, settled: true });
}
