// Only provider identifiers enter this private per-send receipt. Each array keeps at
// most two distinct values: a second value already establishes a stratum change.
export function wireIdentity(headers: Headers, secret: string) {
  const response_ids: string[] = [],
    fingerprints: string[] = [];
  const safe = (value: unknown) =>
    typeof value === "string" &&
    /^[A-Za-z0-9_.:-]{1,200}$/.test(value) &&
    !value.includes(secret)
      ? value
      : null;
  const add = (list: string[], value: unknown) => {
    const id = safe(value);
    if (id && list.length < 2 && !list.includes(id)) list.push(id);
  };
  const provider_request_ids: string[] = [];
  for (const key of ["x-request-id", "request-id", "x-ds-request-id"])
    add(provider_request_ids, headers.get(key));
  let frames = 0,
    fieldSeen = false,
    invalid = false;
  return {
    observe(frame: any) {
      frames++;
      const response = frame.response ?? frame;
      add(response_ids, response.id);
      for (const obj of response === frame ? [frame] : [frame, response]) {
        if (Object.hasOwn(obj, "system_fingerprint")) {
          const fp = obj.system_fingerprint;
          fieldSeen = true;
          if (fp !== null && !safe(fp)) invalid = true;
          add(fingerprints, fp);
        }
      }
    },
    receipt(complete: boolean) {
      return {
        provider_request_ids: [...provider_request_ids],
        response_ids: [...response_ids],
        system_fingerprints: [...fingerprints],
        fingerprint_status: invalid
          ? "INVALID"
          : fingerprints.length > 1
            ? "CHANGED_WITHIN_SEND"
            : fingerprints.length
              ? "PRESENT"
              : !complete || !frames
                ? "UNKNOWN"
                : fieldSeen
                  ? "NULL"
                  : "ABSENT",
        observed_frames: frames,
        scope: "PHYSICAL_SEND",
        immutable_revision: "UNKNOWN",
      };
    },
  };
}
