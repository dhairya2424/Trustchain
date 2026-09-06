/**
 * Structured logging on pino, behind the existing `Logger` interface.
 *
 * `ConsoleLogger` stays as the dependency-free implementation used by tests and scripts;
 * this is what the server runs. Keeping both behind one interface is why swapping the
 * transport touched no call site.
 *
 * Everything goes to stdout as newline-delimited JSON and nothing is written to a file or
 * rotated. In a container the process is not the right thing to be managing log retention:
 * the platform collects stdout, and a process that also writes files ends up with two
 * copies, one of which nobody ships and nobody deletes.
 */
import { pino, type Logger as Pino, type LoggerOptions } from "pino";
import pinoHttp, { type HttpLogger } from "pino-http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { redact, type LogRecord, type Logger } from "./logger";

/**
 * Paths pino blanks before serialisation.
 *
 * This overlaps with `redact()` from `logger.ts`, deliberately. `redact()` walks by key
 * name at any depth and catches an `authorization` field wherever it appears in an
 * application log record; pino's path-based redaction catches the HTTP serialisers'
 * output, which `redact()` never sees because pino-http builds it internally. Neither
 * covers the other, and a secret in a log line is not the place to economise.
 */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'req.headers["cf-turnstile-response"]',
  'req.headers["proxy-authorization"]',
  "res.headers['set-cookie']",
  "headers.authorization",
  "headers.cookie",
  "*.authorization",
  "*.cookie",
  "*.password",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.privateKey",
  "*.secret",
];

export interface PinoOptions {
  level?: LoggerOptions["level"];
  /** Where lines go. Defaults to stdout. Injected so tests can read what was written. */
  destination?: NodeJS.WritableStream;
  /** Included on every line so a log aggregator can separate deployments. */
  service?: string;
  environment?: string;
  version?: string;
}

export function createPino(options: PinoOptions = {}): Pino {
  const config: LoggerOptions = {
    level: options.level ?? process.env.LOG_LEVEL ?? "info",
    base: {
      service: options.service ?? "trustchain-backend",
      env: options.environment ?? process.env.NODE_ENV ?? "development",
      ...(options.version ? { version: options.version } : {}),
    },
    // ISO timestamps rather than epoch millis: a human reads these during an incident.
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    formatters: {
      // Ship the word, not the number. `level: 30` means nothing in a query bar.
      level: (label) => ({ level: label }),
    },
  };

  return options.destination ? pino(config, options.destination) : pino(config);
}

/** Adapts pino to the `Logger` interface the rest of the backend already uses. */
export class PinoLogger implements Logger {
  constructor(private readonly instance: Pino = createPino()) {}

  log(record: LogRecord): void {
    const { level, msg, ...rest } = record;
    this.instance[level](redact(rest) as Record<string, unknown>, msg);
  }

  /** Escape hatch for pino-http and for tests that need the raw instance. */
  get pino(): Pino {
    return this.instance;
  }
}

/**
 * Per-request access logging.
 *
 * `genReqId` reuses the id `requestId()` already assigned, so an access line and every
 * application line from the same request carry the same `requestId` and can be joined in
 * the aggregator. Generating a second id here would produce two unrelated traces for one
 * request, which is worse than no id at all because it looks correct.
 *
 * The serialisers are explicit allowlists. pino-http's defaults log every request header,
 * and the set of headers that turn out to carry a secret is not fixed — today it is
 * `authorization` and `cf-turnstile-response`, tomorrow it is whatever a new integration
 * adds. Naming what to keep fails closed; naming what to drop fails open.
 */
export function httpLogger(instance: Pino): HttpLogger {
  return pinoHttp({
    logger: instance,
    genReqId: (req: IncomingMessage & { requestId?: string }, res: ServerResponse) => {
      const id = req.requestId ?? "";
      if (id) res.setHeader("x-request-id", id);
      return id;
    },
    // Promoted to the top level under exactly the name the application logger uses. pino-http
    // would otherwise nest it as `req.id`, and an aggregator query cannot join `req.id` on
    // one line against `requestId` on the next without knowing they are the same thing.
    customProps: (req: IncomingMessage & { requestId?: string }) => ({
      requestId: req.requestId ?? "",
    }),
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    customSuccessMessage: () => "http.request",
    customErrorMessage: () => "http.request_failed",
    serializers: {
      req: (req: IncomingMessage & { url?: string; method?: string }) => ({
        method: req.method,
        // Query strings can carry identifiers and tokens; the path alone is enough to
        // tell one route from another.
        path: (req.url ?? "").split("?")[0],
        userAgent: req.headers?.["user-agent"],
        contentType: req.headers?.["content-type"],
      }),
      res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
      err: (error: Error) => ({
        type: error.name,
        message: error.message,
        // Stacks reveal absolute paths and dependency versions. Kept outside production,
        // where they are the fastest way to understand a failure locally.
        ...(process.env.NODE_ENV === "production" ? {} : { stack: error.stack }),
      }),
    },
  });
}
