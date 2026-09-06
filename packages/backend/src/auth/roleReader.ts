import { createPublicClient, http, type Address, type PublicClient } from "viem";

export interface IdentitySnapshot {
  /** Role identifiers held on-chain. Empty when the address holds none. */
  roles: readonly string[];
  /** DID hash bound to the address, or null when none is registered. */
  did: string | null;
}

export interface RoleReader {
  read(address: Address): Promise<IdentitySnapshot>;
}

const ROLE_ACCESS_CONTROL_ABI = [
  {
    type: "function",
    name: "rolesOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "bytes32[]" }],
  },
] as const;

const DID_REGISTRY_ABI = [
  {
    type: "function",
    name: "didOf",
    stateMutability: "view",
    inputs: [{ name: "controller", type: "address" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

const ZERO_BYTES32 = `0x${"0".repeat(64)}`;

/**
 * Reads roles and identity straight from the chain.
 *
 * This is the point of the whole design: authorization is whatever RoleAccessControl says
 * right now, not whatever a token claims. The API can be wrong, compromised, or out of
 * date — it still cannot grant anyone a role, because it never decides. Sessions are
 * short-lived precisely so a revoked role stops working quickly.
 */
export class OnChainRoleReader implements RoleReader {
  private readonly client: PublicClient;

  constructor(
    private readonly addresses: { roleAccessControl: Address; didRegistry: Address },
    rpcUrl: string,
    client?: PublicClient,
  ) {
    this.client = client ?? (createPublicClient({ transport: http(rpcUrl) }) as PublicClient);
  }

  async read(address: Address): Promise<IdentitySnapshot> {
    const [roles, did] = await Promise.all([
      this.client.readContract({
        address: this.addresses.roleAccessControl,
        abi: ROLE_ACCESS_CONTROL_ABI,
        functionName: "rolesOf",
        args: [address],
      }),
      this.client.readContract({
        address: this.addresses.didRegistry,
        abi: DID_REGISTRY_ABI,
        functionName: "didOf",
        args: [address],
      }),
    ]);

    return {
      roles: [...(roles as readonly string[])],
      did: did === ZERO_BYTES32 ? null : (did as string),
    };
  }
}
