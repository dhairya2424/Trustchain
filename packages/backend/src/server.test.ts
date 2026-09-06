import { describe, expect, it } from "vitest";
import request from "supertest";
import { createServer } from "./server";

describe("skeleton server", () => {
  it("serves /health", async () => {
    const res = await request(createServer()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});
