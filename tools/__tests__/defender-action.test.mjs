// The Defender Action is the code that runs when someone changes who can do what.
// Shipping it unexercised would mean the first time it runs is the first time it matters.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const { handler } = require(path.join(repoRoot, "infra", "defender", "action-alert.js"));

const ADMIN_ROLE = "0xa49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775";
const MANAGER_ROLE = "0x241ecf16d79d0f8dbfb92cbc07fe17840425976cf0667f022fe9877caa831b08";
const WEBHOOK = "https://hooks.example.test/trustchain";

function event(matchReasons, { secrets = { ALERT_WEBHOOK_URL: WEBHOOK } } = {}) {
  return {
    secrets,
    request: {
      body: {
        matchReasons,
        transaction: { transactionHash: "0xdeadbeef" },
        sentinel: { network: "matic-amoy" },
      },
    },
  };
}

function captureFetch(response = { ok: true, status: 200 }) {
  const spy = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("defender alert action", () => {
  it("names a role rather than reporting a raw hash", async () => {
    const fetchSpy = captureFetch();

    await handler(
      event([
        {
          signature: "RoleGranted(bytes32,address,address)",
          params: { role: ADMIN_ROLE, account: "0xACC", sender: "0xSENDER" },
        },
      ]),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.text).to.include("ADMIN_ROLE");
    expect(body.text).to.not.include(ADMIN_ROLE);
    expect(body.text).to.include("0xACC");
  });

  it("treats admin role changes as critical and minting as routine", async () => {
    const fetchSpy = captureFetch();

    const adminResult = await handler(
      event([
        {
          signature: "RoleGranted(bytes32,address,address)",
          params: { role: ADMIN_ROLE, account: "0xACC", sender: "0xS" },
        },
      ]),
    );
    expect(adminResult.critical).toBe(1);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).text).to.include("CRITICAL");

    const mintResult = await handler(
      event([
        {
          signature: "AssetMinted(uint256,bytes32,address,string,bool,address)",
          params: { tokenId: "7", ownerDID: "0xDID", mintedBy: "0xMGR" },
        },
      ]),
    );
    expect(mintResult.critical).toBe(0);
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body).text).to.not.include("CRITICAL");
  });

  it("flags a permission change as critical — that is how a takeover looks", async () => {
    const fetchSpy = captureFetch();

    const result = await handler(
      event([
        {
          signature: "PermissionUpdated(bytes32,bytes32,bool,address)",
          params: { role: MANAGER_ROLE, permission: "0xPERM", allowed: true, updatedBy: "0xADM" },
        },
      ]),
    );

    expect(result.critical).toBe(1);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).text).to.include("MANAGER_ROLE");
  });

  it("reports every match in one alert", async () => {
    const fetchSpy = captureFetch();

    const result = await handler(
      event([
        {
          signature: "RoleGranted(bytes32,address,address)",
          params: { role: ADMIN_ROLE, account: "0xA", sender: "0xS" },
        },
        {
          signature: "RoleRevoked(bytes32,address,address)",
          params: { role: MANAGER_ROLE, account: "0xB", sender: "0xS" },
        },
      ]),
    );

    expect(result.handled).toBe(2);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.text).to.include("ADMIN_ROLE");
    expect(body.text).to.include("MANAGER_ROLE");
  });

  it("throws rather than silently dropping an alert when the webhook is unset", async () => {
    captureFetch();

    await expect(
      handler(
        event(
          [
            {
              signature: "RoleGranted(bytes32,address,address)",
              params: { role: ADMIN_ROLE, account: "0xA", sender: "0xS" },
            },
          ],
          { secrets: {} },
        ),
      ),
    ).rejects.toThrow(/ALERT_WEBHOOK_URL/);
  });

  it("throws when the webhook rejects, so Defender retries instead of losing it", async () => {
    captureFetch({ ok: false, status: 500 });

    await expect(
      handler(
        event([
          {
            signature: "RoleGranted(bytes32,address,address)",
            params: { role: ADMIN_ROLE, account: "0xA", sender: "0xS" },
          },
        ]),
      ),
    ).rejects.toThrow(/500/);
  });

  it("does nothing when there is nothing to report", async () => {
    const fetchSpy = captureFetch();

    const result = await handler(event([]));

    expect(result.handled).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
