import { stageCases } from "./stage-c-plan.ts";

export function familyResults(
  rows: {
    family: string;
    source_lineage: string;
    status: string;
    grades: Record<string, string>;
  }[],
) {
  const excluded = stageCases()
    .filter((c) => c.status !== "READY_FOR_OFFLINE_VALIDATION")
    .map((c) => ({
      scenario: c.id,
      family: c.family,
      disposition: c.status,
      route: c.route,
      reason:
        c.id === "C12a"
          ? "Archived checkpoint evidence; original OS process witness unavailable"
          : c.id.startsWith("C15")
            ? "Clock-dependent evaluation tracked in #125"
            : c.status,
    }));
  const families = Object.fromEntries(
    ["M1", "M2", "M3", "M4", "M5", "M6"].map((family) => {
      const group = rows.filter((r) => r.family === family);
      return [
        family,
        {
          observations: group.length,
          lineages: new Set(group.map((r) => r.source_lineage)).size,
          incomplete: group.filter((r) => r.status === "INCOMPLETE").length,
          unrun: group.filter((r) => ["UNRUN", "NOT_RUN"].includes(r.status))
            .length,
          assertions: Object.fromEntries(
            ["PASS", "FAIL", "UNRESOLVED", "NOT_TESTED"].map((v) => [
              v,
              group.reduce(
                (n, r) =>
                  n + Object.values(r.grades).filter((x) => x === v).length,
                0,
              ),
            ]),
          ),
          exclusions: excluded.filter((r) => r.family === family).length,
        },
      ];
    }),
  );
  return { families, excluded };
}
