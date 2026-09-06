import { describe, expect, it } from "vitest";

import { auditEventToRow, csvField, csvHeader, streamAuditCsv, CSV_COLUMNS } from "./csv";
import type { RawAuditEvent } from "./events";

function event(overrides: Partial<RawAuditEvent> = {}): RawAuditEvent {
  return {
    entryId: 7,
    didHash: `0x${"1".repeat(64)}`,
    actionCode: 11,
    refHash: `0x${"2".repeat(64)}`,
    via: "0x1111111111111111111111111111111111111111",
    actor: "0x2222222222222222222222222222222222222222",
    blockNumber: 100,
    logIndex: 0,
    transactionHash: `0x${"3".repeat(64)}`,
    timestamp: 1_760_000_000,
    ...overrides,
  };
}

/**
 * Formula injection is the reason this module exists rather than a `join(",")` at the call
 * site. The attacker does not need to reach the API — they need one field on-chain that an
 * ADMIN later exports and opens in a spreadsheet.
 */
describe("csvField — formula injection", () => {
  it.each([
    ["=cmd|'/c calc'!A1", "="],
    ["+1+1", "+"],
    ["-2+3", "-"],
    ["@SUM(A1)", "@"],
  ])("neutralises a field starting with %s", (payload) => {
    const field = csvField(payload);

    // The apostrophe is inside the quotes, immediately before the trigger character:
    // a spreadsheet reads that as "treat this cell as text".
    expect(field).toBe(`"'${payload}"`);
    expect(field.startsWith('"=')).toBe(false);
  });

  it("neutralises a leading tab, which some parsers strip before evaluating", () => {
    expect(csvField("\t=1+1")).toBe(`"'\t=1+1"`);
  });

  it("neutralises a leading carriage return", () => {
    expect(csvField("\r=1+1")).toBe(`"'\r=1+1"`);
  });

  it("does not prefix an ordinary value", () => {
    expect(csvField("CREDENTIAL_ISSUED")).toBe('"CREDENTIAL_ISSUED"');
  });

  it("does not prefix a hash, even though it is long hex", () => {
    expect(csvField("0xabc")).toBe('"0xabc"');
  });

  it("leaves a minus sign inside a value alone", () => {
    expect(csvField("2026-01-01T00:00:00.000Z")).toBe('"2026-01-01T00:00:00.000Z"');
  });
});

describe("csvField — row integrity", () => {
  it("doubles an embedded quote so the field cannot be closed early", () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
  });

  it("contains an embedded newline inside the quotes rather than splitting the row", () => {
    const field = csvField("line one\nline two");

    expect(field).toBe('"line one\nline two"');
    expect(field.startsWith('"')).toBe(true);
    expect(field.endsWith('"')).toBe(true);
  });

  it("does not let a CRLF forge a second row", () => {
    const payload = 'genuine\r\n999,"forged entry"';
    const field = csvField(payload);

    // The real property is round-trip integrity: the whole payload — CRLF, comma and
    // quotes included — survives as ONE field. Undoing the RFC 4180 escaping must give
    // back exactly what went in, which it cannot if the value escaped its own quoting.
    expect(field.startsWith('"')).toBe(true);
    expect(field.endsWith('"')).toBe(true);

    const unescaped = field.slice(1, -1).replace(/""/g, '"');
    expect(unescaped).toBe(payload);
  });

  it("quotes an embedded comma", () => {
    expect(csvField("a,b")).toBe('"a,b"');
  });

  it("renders null and undefined as an empty field, not the word", () => {
    expect(csvField(null)).toBe('""');
    expect(csvField(undefined)).toBe('""');
  });
});

describe("csv rows", () => {
  it("writes a header naming every column", () => {
    const header = csvHeader();

    for (const column of CSV_COLUMNS) expect(header).toContain(column);
    expect(header.endsWith("\r\n")).toBe(true);
  });

  it("renders an entry with a readable action name and an ISO timestamp", () => {
    const row = auditEventToRow(event());

    expect(row).toContain("CREDENTIAL_ISSUED");
    expect(row).toContain(new Date(1_760_000_000 * 1000).toISOString());
  });

  it("renders an unknown action code rather than dropping the row", () => {
    expect(auditEventToRow(event({ actionCode: 250 }))).toContain("UNKNOWN_ACTION_250");
  });

  it("renders a missing actor as an empty field", () => {
    const row = auditEventToRow(event({ actor: null }));

    expect(row).toContain('"",');
  });

  it("emits one row per entry", () => {
    expect(auditEventToRow(event()).split("\r\n").filter(Boolean)).toHaveLength(1);
  });
});

describe("streamAuditCsv", () => {
  const collect = async (gen: AsyncGenerator<string>) => {
    const chunks: string[] = [];
    for await (const chunk of gen) chunks.push(chunk);
    return chunks;
  };

  it("emits a header even when there are no entries", async () => {
    const chunks = await collect(streamAuditCsv({ fetchPage: async () => [], maxRows: 10 }));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("entryId");
  });

  it("pages until the source is exhausted", async () => {
    const pages = [[event({ entryId: 9 })], [event({ entryId: 8 })], []];
    let call = 0;

    const chunks = await collect(
      streamAuditCsv({ fetchPage: async () => pages[call++] ?? [], maxRows: 100 }),
    );

    expect(chunks).toHaveLength(3); // header + two rows
    expect(call).toBe(3);
  });

  it("passes the last entry id of each page back as the cursor", async () => {
    const seen: (number | undefined)[] = [];
    const pages = [[event({ entryId: 9 }), event({ entryId: 8 })], []];
    let call = 0;

    await collect(
      streamAuditCsv({
        fetchPage: async (before) => {
          seen.push(before);
          return pages[call++] ?? [];
        },
        maxRows: 100,
      }),
    );

    expect(seen).toEqual([undefined, 8]);
  });

  it("stops at maxRows and says in the file that it truncated", async () => {
    const page = [event({ entryId: 3 }), event({ entryId: 2 }), event({ entryId: 1 })];

    const chunks = await collect(streamAuditCsv({ fetchPage: async () => page, maxRows: 2 }));

    // header + 2 rows + the truncation marker
    expect(chunks).toHaveLength(4);
    expect(chunks[3]).toContain("export truncated at 2 rows");
  });

  it("does not loop forever once entry zero is reached", async () => {
    let call = 0;
    const chunks = await collect(
      streamAuditCsv({
        fetchPage: async () => (call++ === 0 ? [event({ entryId: 0 })] : []),
        maxRows: 100,
      }),
    );

    expect(call).toBe(1);
    expect(chunks).toHaveLength(2);
  });
});
