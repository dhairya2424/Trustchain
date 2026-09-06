/**
 * Structured logging with redaction.
 *
 * Deliberately tiny and dependency-free at this stage. The important property is not the
 * transport but that a security event carries a request id: an alert nobody can trace
 * back to a request is an alert nobody can act on.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  level: LogLevel;
  msg: string;
  requestId?: string;
  [key: string]: unknown;
}

export interface Logger {
  log(record: LogRecord): void;
}

/** Fields that must never reach a log line, at any nesting depth. */
const REDACTED_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "signature",
  "token",
  "turnstiletoken",
  "accesstoken",
  "refreshtoken",
  "privatekey",
  "secret",
]);

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = REDACTED_KEYS.has(key.toLowerCase()) ? "[redacted]" : redact(entry, depth + 1);
  }
  return output;
}

export class ConsoleLogger implements Logger {
  // Structured lines go to stdout for a log shipper to pick up (see P2.5).
  // eslint-disable-next-line no-console
  constructor(private readonly sink: (line: string) => void = console.log) {}

  log(record: LogRecord): void {
    const { level, msg, ...rest } = record;
    this.sink(
      JSON.stringify({
        level,
        msg,
        time: new Date().toISOString(),
        ...(redact(rest) as Record<string, unknown>),
      }),
    );
  }
}

/** Collects records instead of writing them. Used by tests to assert on log output. */
export class MemoryLogger implements Logger {
  readonly records: LogRecord[] = [];

  log(record: LogRecord): void {
    this.records.push({ ...record, ...(redact(record) as LogRecord) });
  }

  find(msg: string): LogRecord | undefined {
    return this.records.find((r) => r.msg === msg);
  }
}
