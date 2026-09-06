import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import express from "express";
import request from "supertest";

import { createPino, httpLogger, PinoLogger } from "./pinoLogger";
import { requestId } from "./middleware";

/** Collects the newline-delimited JSON pino writes, so tests read real output. */
function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });

  return {
    stream,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("PinoLogger", () => {
  it("emits one JSON object per line, which is what a log shipper expects", () => {
    const sink = capture();
    const logger = new PinoLogger(createPino({ destination: sink.stream }));

    logger.log({ level: "info", msg: "first" });
    logger.log({ level: "info", msg: "second" });

    expect(sink.lines()).toHaveLength(2);
  });

  it("writes the level as a word, not as a number", () => {
    const sink = capture();
    new PinoLogger(createPino({ destination: sink.stream })).log({ level: "warn", msg: "x" });

    expect(sink.lines()[0]?.level).toBe("warn");
  });

  it("writes an ISO timestamp, which a human can read during an incident", () => {
    const sink = capture();
    new PinoLogger(createPino({ destination: sink.stream })).log({ level: "info", msg: "x" });

    expect(String(sink.lines()[0]?.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("stamps service and environment so one aggregator can hold several deployments", () => {
    const sink = capture();
    new PinoLogger(
      createPino({ destination: sink.stream, service: "svc", environment: "production" }),
    ).log({ level: "info", msg: "x" });

    const line = sink.lines()[0];
    expect(line?.service).toBe("svc");
    expect(line?.env).toBe("production");
  });

  it("carries the request id through to the line", () => {
    const sink = capture();
    new PinoLogger(createPino({ destination: sink.stream })).log({
      level: "info",
      msg: "x",
      requestId: "abc-123",
    });

    expect(sink.lines()[0]?.requestId).toBe("abc-123");
  });
});

describe("PinoLogger — redaction", () => {
  const emit = (record: Record<string, unknown>) => {
    const sink = capture();
    new PinoLogger(createPino({ destination: sink.stream })).log({
      level: "info",
      msg: "x",
      ...record,
    });
    return JSON.stringify(sink.lines()[0]);
  };

  it("redacts an Authorization value", () => {
    const line = emit({ authorization: "Bearer super-secret-token" });

    expect(line).not.toContain("super-secret-token");
    expect(line).toContain("[redacted]");
  });

  it("redacts a cookie value", () => {
    expect(emit({ cookie: "trustchain_session=abc123" })).not.toContain("abc123");
  });

  it("redacts a nested credential, not only a top-level one", () => {
    const line = emit({ context: { headers: { authorization: "Bearer nested-secret" } } });

    expect(line).not.toContain("nested-secret");
  });

  it("redacts a private key and a refresh token", () => {
    // Inert fixtures; neither is a real credential.
    const line = emit({ privateKey: "0xdeadbeefkey", refreshToken: "rt" }); // secrets-scan:allow

    expect(line).not.toContain("0xdeadbeefkey");
    expect(line).not.toContain('"rt"');
  });

  it("leaves ordinary diagnostic fields intact", () => {
    const line = emit({ tokenId: "42", path: "/assets/42" });

    expect(line).toContain("/assets/42");
    expect(line).toContain("42");
  });
});

describe("httpLogger", () => {
  const build = () => {
    const sink = capture();
    const instance = createPino({ destination: sink.stream });
    const app = express();
    app.use(requestId());
    app.use(httpLogger(instance));
    app.get("/thing", (_req, res) => res.json({ ok: true }));
    app.get("/missing", (_req, res) => res.status(404).json({ error: "nope" }));
    app.get("/broken", (_req, res) => res.status(500).json({ error: "boom" }));
    return { app, sink };
  };

  it("logs one access line per request", async () => {
    const { app, sink } = build();
    await request(app).get("/thing");

    const access = sink.lines().filter((l) => l.msg === "http.request");
    expect(access).toHaveLength(1);
  });

  it("reuses the id from requestId, so access and application lines join up", async () => {
    const { app, sink } = build();
    const res = await request(app).get("/thing").set("x-request-id", "trace-abcdef12");

    expect(res.headers["x-request-id"]).toBe("trace-abcdef12");
    // Under `requestId`, the same field name the application logger uses — an aggregator
    // cannot join `req.id` on one line against `requestId` on the next.
    expect(sink.lines()[0]?.requestId).toBe("trace-abcdef12");
  });

  it("raises the level with the status code", async () => {
    const { app, sink } = build();
    await request(app).get("/missing");
    await request(app).get("/broken");

    const levels = sink.lines().map((l) => l.level);
    expect(levels).toContain("warn");
    expect(levels).toContain("error");
  });

  it("logs the path without the query string, which can carry identifiers", async () => {
    const { app, sink } = build();
    await request(app).get("/thing?token=should-not-be-logged");

    const line = JSON.stringify(sink.lines());
    expect(line).toContain("/thing");
    expect(line).not.toContain("should-not-be-logged");
  });

  it("does not log request headers by default, because the serialiser is an allowlist", async () => {
    const { app, sink } = build();
    await request(app).get("/thing").set("authorization", "Bearer header-secret-value");

    expect(JSON.stringify(sink.lines())).not.toContain("header-secret-value");
  });

  it("does not log a cookie header", async () => {
    const { app, sink } = build();
    await request(app).get("/thing").set("cookie", "trustchain_session=cookie-secret");

    expect(JSON.stringify(sink.lines())).not.toContain("cookie-secret");
  });
});
