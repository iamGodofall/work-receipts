import { createHash } from "node:crypto";

/**
 * Canonicalize JSON-compatible data by sorting object keys recursively.
 * Reject unsupported values rather than silently producing ambiguous digests.
 */
export function canonicalJson(value: unknown): string {
  const normalized = normalize(value, new WeakSet<object>());
  return JSON.stringify(normalized);
}

function normalize(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON requires finite numbers.");
    }
    return value;
  }

  if (typeof value !== "object") {
    throw new TypeError("Value is not JSON-compatible.");
  }

  if (ancestors.has(value)) {
    throw new TypeError("Canonical JSON does not support circular references.");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => normalize(item, ancestors));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON accepts plain objects only.");
    }

    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) {
        throw new TypeError("Undefined object values are not supported.");
      }
      normalized[key] = normalize(item, ancestors);
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Object(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * A hash establishes byte-level identity under a known canonicalization rule.
 * It does not prove that a claim is true or that an external system behaved
 * correctly.
 */