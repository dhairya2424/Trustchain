import { createPublicClient, http, type Address, type PublicClient } from "viem";

import { PERMISSION_IDS, type PermissionName } from "./roles";

export interface IdentitySnapshot {
  /** Role identifiers held on-chain. Empty when the address holds none. */
  roles: readonly string[];
  /** DID hash bound to the address, or null when none is registered. */
  did: string | null;
}

export interface RoleReader {
  read(address: Address): Promise<IdentitySnapshot>;
}

/**
 * Answers "may this account do this?" straight from RoleAccessControl.
 *
 * Separate from {@link RoleReader} because the two are consulted at different moments:
 * roles are read once when a session is minted, permissions are read on every mutation.
 */
export interface PermissionReader {
  hasPermission(address: Address, permission: PermissionName): Promise<boolean>;
}

const ROLE_ACCESS_CONTROL_ABI = [
  {
    type: "function",
    name: "rolesOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "bytes32[]" }],
  },
  {
    type: "function",
    name: "hasPermission",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "permission", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
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
export class OnChainRoleReader implements RoleReader, PermissionReader {
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

  /**
   * Asks the contract directly rather than deriving the answer from `rolesOf`.
   *
   * An ADMIN can re-scope which permissions a role carries at runtime, so a local
   * role-to-permission table in this process would be a cached copy of a matrix that
   * changes without us. Asking the contract costs one RPC call and cannot go stale.
   */
  async hasPermission(address: Address, permission: PermissionName): Promise<boolean> {
    const result = await this.client.readContract({
      address: this.addresses.roleAccessControl,
      abi: ROLE_ACCESS_CONTROL_ABI,
      functionName: "hasPermission",
      args: [address, PERMISSION_IDS[permission]],
    });

    return result as boolean;
  }
}
