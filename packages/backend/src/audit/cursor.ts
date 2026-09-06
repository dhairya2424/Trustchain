import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

import { parseKey } from "../db/crypto";
import type { AuditFilter } from "./events";

/**
 * Opaque, tamper-evident pagination cursors.
 *
 * Three properties, each earning its place:
 *
 * 1. **Keyset, not offset.** The cursor carries the last entry id seen, so a page is
 *    "entries below id N". An OFFSET-based cursor drifts whenever rows are inserted
 *    mid-scan, and the audit trail is append-only — new entries arrive at exactly the end
 *    a reader is paging away from, so an offset would silently repeat or skip rows.
 *
 * 2. **Signed.** The cursor is an input like any other. Unsigned, it is a client-supplied
 *    integer spliced into a query; signed, a modified cursor is rejected before it reaches
 *    the source. This is defence in depth — the id is bounds-checked anyway — but it also
 *    makes the cursor genuinely opaque, so its encoding stays ours to change.
 *
 * 3. **Filter-bound.** The signature covers a hash of the filter the cursor was issued
 *    for. Continuing a scan with different filters is then a 400 rather than a page of
 *    results that belong to neither query. Without this, changing `actor` mid-scan
 *    produces output an auditor would reasonably read as a complete history.
 *
 * The signing key is derived from the field-encryption key via HKDF rather than reusing
 * it directly, so this signature and a database ciphertext never share key material.
 */

const CURSOR_INFO = Buffer.from("trustchain/audit-cursor/v1", "utf8");
const CURSOR_SALT = Buffer.from("trustchain-audit", "utf8");
const KEY_BYTES = 32;

export class CursorError extends Error {
  constructor(
    message: string,
    readonly code: "malformed" | "bad_signature" | "filter_changed",
  ) {
    super(message);
    this.name = "CursorError";
  }
}

export interface CursorPayload {
  entryId: number;
  filterHash: string;
}

function b64url(input: Buffer): string {
  return input.toString("base64url");
}

/** The filter fields a cursor is bound to. `limit` is excluded: page size may vary. */
export function filterFingerprint(filter: Partial<AuditFilter>): string {
  const canonical = JSON.stringify({
    actor: filter.actor?.toLowerCase() ?? null,
    didHash: filter.didHash?.toLowerCase() ?? null,
    actionCode: filter.actionCode ?? null,
    from: filter.from ?? null,
    to: filter.to ?? null,
  });

  return createHmac("sha256", CURSOR_INFO).update(canonical).digest("base64url").slice(0, 16);
}

export class CursorCodec {
  private readonly key: Buffer;

  constructor(base64EncryptionKey: string) {
    // HKDF, not the raw key: one secret, distinct derived keys per purpose, so a flaw in
    // one use cannot be leveraged against the other.
    this.key = Buffer.from(
      hkdfSync("sha256", parseKey(base64EncryptionKey), CURSOR_SALT, CURSOR_INFO, KEY_BYTES),
    );
  }

  private sign(body: string): Buffer {
    return createHmac("sha256", this.key).update(body).digest();
  }

  encode(payload: CursorPayload): string {
    const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
    return `${body}.${b64url(this.sign(body))}`;
  }

  decode(cursor: string, expectedFilterHash: string): CursorPayload {
    const separator = cursor.lastIndexOf(".");
    if (separator <= 0) throw new CursorError("cursor is not well formed", "malformed");

    const body = cursor.slice(0, separator);
    const signature = Buffer.from(cursor.slice(separator + 1), "base64url");
    const expected = this.sign(body);

    // Length check first: timingSafeEqual throws on a length mismatch, and an attacker
    // controls the length.
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
      throw new CursorError("cursor signature does not verify", "bad_signature");
    }

    let payload: CursorPayload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CursorPayload;
    } catch {
      throw new CursorError("cursor payload is not valid JSON", "malformed");
    }

    if (!Number.isInteger(payload.entryId) || payload.entryId < 0) {
      throw new CursorError("cursor entry id is not a non-negative integer", "malformed");
    }

    if (payload.filterHash !== expectedFilterHash) {
      throw new CursorError(
        "cursor was issued for a different set of filters; restart the query",
        "filter_changed",
      );
    }

    return payload;
  }
}
