import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex, sha256Object } from "../integrity";

describe("canonicalJson and SHA-256 integrity", () => {
  it("sorts object keys recursively but preserves array order", () => {
    expect(canonicalJson({ z: 1, nested: { b: true, a: false }, a: 2 }))
      .toBe(canonicalJson({ a: 2, nested: { a: false, b: true }, z: 1 }));
    expect(canonicalJson(["first", "second"])).not.toBe(canonicalJson(["second", "first"]));
  });

  it("produces the same digest for equivalent objects with different key order", () => {
    expect(sha256Object({ b: 2, a: 1 })).toBe(sha256Object({ a: 1, b: 2 }));
  });

  it("rejects circular data rather than generating an ambiguous digest", () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(() => canonicalJson(value)).toThrow(/circular references/i);
  });

  it("computes SHA-256 hex strings", () => {
    expect(sha256Hex("abc")).toHaveLength(64);
  });

  it("rejects undefined values and non-finite numbers", () => {
    expect(() => canonicalJson({ value: undefined })).toThrow(/undefined/i);
    expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow(/finite numbers/i);
  });
});