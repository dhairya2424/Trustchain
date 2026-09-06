/**
 * Action codes, mirrored from `contracts/libraries/ActionCodes.sol`.
 *
 * The numeric code is what is permanently recorded on-chain; these names exist only so a
 * human reading an export sees "CREDENTIAL_REVOKED" rather than "12". The mapping is
 * append-only for the same reason the Solidity library is: renumbering a code would
 * retroactively change the meaning of history already written, and there is no migration
 * for an immutable ledger.
 *
 * A test asserts this table against the Solidity source, so the two cannot drift.
 */
export const ACTION_CODES = {
  DID_REGISTERED: 1,
  DID_CONTROLLER_ROTATED: 2,
  DID_KEY_ROTATED: 3,
  DID_STATUS_CHANGED: 4,
  ROLE_GRANTED: 5,
  ROLE_REVOKED: 6,
  PERMISSION_UPDATED: 7,
  ASSET_MINTED: 8,
  ASSET_TRANSFERRED: 9,
  ASSET_RECLAIMED: 10,
  CREDENTIAL_ISSUED: 11,
  CREDENTIAL_REVOKED: 12,
} as const;

export type ActionName = keyof typeof ACTION_CODES;

export const ACTION_NAMES: Readonly<Record<number, ActionName>> = Object.freeze(
  Object.fromEntries(
    Object.entries(ACTION_CODES).map(([name, code]) => [code, name as ActionName]),
  ) as Record<number, ActionName>,
);

/**
 * Names a code, or reports it as unknown.
 *
 * An unrecognised code is rendered rather than dropped: this API may be older than the
 * contract that wrote the entry, and hiding entries an out-of-date reader cannot name
 * would put holes in an audit log — the one document that must never have holes.
 */
export function actionName(code: number): string {
  return ACTION_NAMES[code] ?? `UNKNOWN_ACTION_${code}`;
}

/** Reverse lookup for the `action` query filter, which accepts a name or a number. */
export function actionCode(name: string): number | null {
  const code = ACTION_CODES[name.toUpperCase() as ActionName];
  return code ?? null;
}
