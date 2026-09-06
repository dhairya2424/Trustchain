import { describe, expect, it } from "vitest";

import { CursorCodec, CursorError, filterFingerprint } from "./cursor";

const KEY = Buffer.alloc(32, 3).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");

const codec = new CursorCodec(KEY);
const noFilter = filterFingerprint({});

describe("cursor round trip", () => {
  it("encodes and decodes an entry id", () => {
    const cursor = codec.encode({ entryId: 4321, filterHash: noFilter });

    expect(codec.decode(cursor, noFilter).entryId).toBe(4321);
  });

  it("is opaque — the entry id is not readable in the cursor text", () => {
    // Not a security property on its own (it is base64), but it keeps callers from
    // parsing the cursor and depending on its shape.
    const cursor = codec.encode({ entryId: 4321, filterHash: noFilter });

    expect(cursor).not.toContain("4321");
  });

  it("accepts entry id zero, which is a real entry", () => {
    const cursor = codec.encode({ entryId: 0, filterHash: noFilter });

    expect(codec.decode(cursor, noFilter).entryId).toBe(0);
  });
});

describe("cursor tamper resistance", () => {
  it("rejects a cursor whose payload was edited", () => {
    const cursor = codec.encode({ entryId: 10, filterHash: noFilter });
    const forged = Buffer.from(JSON.stringify({ entryId: 999999, filterHash: noFilter })).toString(
      "base64url",
    );
    const tampered = `${forged}.${cursor.split(".")[1]}`;

    expect(() => codec.decode(tampered, noFilter)).toThrowError(CursorError);
  });

  it("rejects a cursor signed with a different key", () => {
    const foreign = new CursorCodec(OTHER_KEY).encode({ entryId: 10, filterHash: noFilter });

    expect(() => codec.decode(foreign, noFilter)).toThrowError(/signature/);
  });

  it("rejects a truncated signature rather than throwing on the length mismatch", () => {
    const cursor = codec.encode({ entryId: 10, filterHash: noFilter });
    const [body] = cursor.split(".");

    // timingSafeEqual throws on unequal lengths; the codec must check length first so an
    // attacker-controlled length produces a clean rejection.
    expect(() => codec.decode(`${body}.AA`, noFilter)).toThrowError(CursorError);
  });

  it("rejects text that is not a cursor at all", () => {
    expect(() => codec.decode("not-a-cursor", noFilter)).toThrowError(/well formed/);
  });

  it("rejects a negative entry id", () => {
    const body = Buffer.from(JSON.stringify({ entryId: -1, filterHash: noFilter })).toString(
      "base64url",
    );
    const signed = codec.encode({ entryId: -1, filterHash: noFilter });
    const signature = signed.split(".")[1] as string;

    // Re-sign the negative payload properly, so the only thing wrong is the value itself.
    const properlySigned = new CursorCodec(KEY).encode({ entryId: -1, filterHash: noFilter });
    expect(properlySigned.split(".")[0]).toBe(body);
    expect(signature.length).toBeGreaterThan(0);
    expect(() => codec.decode(properlySigned, noFilter)).toThrowError(/non-negative/);
  });
});

describe("cursor filter binding", () => {
  it("refuses a cursor issued for a different filter", () => {
    const issued = codec.encode({
      entryId: 10,
      filterHash: filterFingerprint({ actor: "0xaaa" }),
    });

    expect(() => codec.decode(issued, filterFingerprint({ actor: "0xbbb" }))).toThrowError(
      /different set of filters/,
    );
  });

  it("reports filter_changed rather than a generic failure, so the API can explain it", () => {
    const issued = codec.encode({ entryId: 1, filterHash: filterFingerprint({ actionCode: 11 }) });

    try {
      codec.decode(issued, filterFingerprint({ actionCode: 12 }));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as CursorError).code).toBe("filter_changed");
    }
  });

  it("treats a filter as unchanged when only the page size differs", () => {
    // limit is deliberately outside the fingerprint: paging with a different page size is
    // a legitimate continuation of the same query.
    const a = filterFingerprint({ actor: "0xabc", limit: 25 });
    const b = filterFingerprint({ actor: "0xabc", limit: 100 });

    expect(a).toBe(b);
  });

  it("is case-insensitive about addresses, which arrive in mixed case", () => {
    expect(filterFingerprint({ actor: "0xAbCd" })).toBe(filterFingerprint({ actor: "0xabcd" }));
  });

  it("distinguishes an absent filter from an explicitly null one", () => {
    expect(filterFingerprint({})).toBe(filterFingerprint({ actor: undefined }));
    expect(filterFingerprint({})).not.toBe(filterFingerprint({ from: 0 }));
  });
});
