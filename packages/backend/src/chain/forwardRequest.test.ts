import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { decodeFunctionData, type Address, type Hex } from "viem";

import {
  buildForwardTypedData,
  encodeForwardExecution,
  ForwardRequestError,
  verifyForwardRequest,
  type ForwardRequest,
} from "./forwardRequest";

const ACTOR_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // secrets-scan:allow public Hardhat test key
const OTHER_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"; // secrets-scan:allow public Hardhat test key

const actor = privateKeyToAccount(ACTOR_KEY);
const other = privateKeyToAccount(OTHER_KEY);

const FORWARDER = "0x1111111111111111111111111111111111111111" as Address;
const ASSET_REGISTRY = "0x2222222222222222222222222222222222222222" as Address;
const FOREIGN = "0x9999999999999999999999999999999999999999" as Address;

function request(overrides: Partial<ForwardRequest> = {}): ForwardRequest {
  return {
    from: actor.address,
    to: ASSET_REGISTRY,
    value: 0n,
    gas: 500_000n,
    nonce: 0n,
    deadline: Math.floor(Date.now() / 1000) + 3600,
    data: "0xdeadbeef",
    ...overrides,
  };
}

function typedData(req = request()) {
  return buildForwardTypedData({
    forwarderName: "TrustChainForwarder",
    forwarderAddress: FORWARDER,
    chainId: 80002,
    request: req,
  });
}

async function sign(account: typeof actor, data: ReturnType<typeof typedData>): Promise<Hex> {
  return account.signTypedData({
    domain: data.domain,
    types: data.types,
    primaryType: "ForwardRequest",
    message: data.message as never,
  });
}

const verify = (data: ReturnType<typeof typedData>, signature: Hex, sessionAddress: string) =>
  verifyForwardRequest({
    typedData: data,
    signature,
    sessionAddress,
    allowedTargets: [ASSET_REGISTRY],
  });

describe("accepting a genuine request", () => {
  it("accepts a request the session's own actor signed", async () => {
    const data = typedData();

    await expect(verify(data, await sign(actor, data), actor.address)).resolves.toBeUndefined();
  });

  it("builds the domain the forwarder will verify against", () => {
    const data = typedData();

    expect(data.domain).toEqual({
      name: "TrustChainForwarder",
      version: "1",
      chainId: 80002,
      verifyingContract: FORWARDER,
    });
    expect(data.primaryType).toBe("ForwardRequest");
  });
});

/**
 * The requirement stated directly: the actor is never taken on the client's word. The
 * client may propose a request, but the identity it is attributed to comes from the
 * server's session.
 */
describe("the actor cannot be chosen by the client", () => {
  it("refuses a request naming an actor other than the session", async () => {
    const data = typedData({ ...request(), from: other.address });
    const signature = await sign(other, data);

    // `other` signed genuinely — but the session belongs to `actor`.
    await expect(verify(data, signature, actor.address)).rejects.toThrowError(ForwardRequestError);
  });

  it("reports actor_mismatch specifically, so the API can explain it", async () => {
    const data = typedData({ ...request(), from: other.address });

    try {
      await verify(data, await sign(other, data), actor.address);
      expect.unreachable("should have refused");
    } catch (error) {
      expect((error as ForwardRequestError).code).toBe("actor_mismatch");
    }
  });

  it("refuses a signature from someone other than the named actor", async () => {
    const data = typedData();
    // Claims to be `actor`; signed by `other`.
    const signature = await sign(other, data);

    await expect(verify(data, signature, actor.address)).rejects.toThrowError(/does not verify/);
  });

  it("refuses a signature reused for different calldata", async () => {
    const original = typedData();
    const signature = await sign(actor, original);

    const altered = typedData({ ...request(), data: "0xfeedface" });

    await expect(verify(altered, signature, actor.address)).rejects.toThrowError(/does not verify/);
  });

  it("refuses a signature reused for a different target", async () => {
    const original = typedData();
    const signature = await sign(actor, original);

    const redirected = typedData({ ...request(), to: FOREIGN });

    await expect(
      verifyForwardRequest({
        typedData: redirected,
        signature,
        sessionAddress: actor.address,
        allowedTargets: [ASSET_REGISTRY, FOREIGN],
      }),
    ).rejects.toThrowError(/does not verify/);
  });
});

/**
 * Without a target allowlist an authenticated user could have the platform's funded relayer
 * submit arbitrary calldata to any contract on the network — an open relay, paid for by us,
 * carrying our relayer's address on every transaction.
 */
describe("the relayer is not an open relay", () => {
  it("refuses a target the platform does not own", async () => {
    const data = typedData({ ...request(), to: FOREIGN });

    try {
      await verify(data, await sign(actor, data), actor.address);
      expect.unreachable("should have refused");
    } catch (error) {
      expect((error as ForwardRequestError).code).toBe("target_not_allowed");
    }
  });

  it("checks the target before spending effort on signature recovery", async () => {
    // A bogus signature with a disallowed target still fails on the target, which keeps an
    // unauthenticated flood cheap to reject.
    const data = typedData({ ...request(), to: FOREIGN });

    try {
      await verify(data, "0x00", actor.address);
      expect.unreachable("should have refused");
    } catch (error) {
      expect((error as ForwardRequestError).code).toBe("target_not_allowed");
    }
  });
});

describe("value and expiry", () => {
  it("refuses a request that would move native currency", async () => {
    const data = typedData({ ...request(), value: 1n });

    try {
      await verify(data, await sign(actor, data), actor.address);
      expect.unreachable("should have refused");
    } catch (error) {
      // The relayer holds gas money; a forwarded request moving value would spend it.
      expect((error as ForwardRequestError).code).toBe("value_not_zero");
    }
  });

  it("refuses an expired request", async () => {
    const data = typedData({ ...request(), deadline: Math.floor(Date.now() / 1000) - 1 });

    try {
      await verify(data, await sign(actor, data), actor.address);
      expect.unreachable("should have refused");
    } catch (error) {
      expect((error as ForwardRequestError).code).toBe("expired");
    }
  });
});

describe("encodeForwardExecution", () => {
  it("encodes a call the forwarder can execute, carrying the signature", () => {
    const req = request();
    const signature = "0xabcdef" as Hex;

    const decoded = decodeFunctionData({
      abi: [
        {
          type: "function",
          name: "execute",
          stateMutability: "payable",
          inputs: [
            {
              name: "request",
              type: "tuple",
              components: [
                { name: "from", type: "address" },
                { name: "to", type: "address" },
                { name: "value", type: "uint256" },
                { name: "gas", type: "uint256" },
                { name: "deadline", type: "uint48" },
                { name: "data", type: "bytes" },
                { name: "signature", type: "bytes" },
              ],
            },
          ],
          outputs: [],
        },
      ] as const,
      data: encodeForwardExecution(req, signature),
    });

    const arg = (decoded.args as readonly { from: string; signature: string }[])[0];
    expect(arg?.from).toBe(actor.address);
    expect(arg?.signature).toBe(signature);
  });

  /** The nonce is signed but read from storage, which is what makes a replay fail. */
  it("does not resubmit the nonce", () => {
    const encoded = encodeForwardExecution(request({ nonce: 42n }), "0xab" as Hex);

    expect(encoded).not.toContain("2a".padStart(64, "0"));
  });
});
