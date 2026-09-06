import type { Logger } from "./logger";

export interface AllowlistResult<T> {
  /** Only the fields the caller is permitted to change. */
  data: Partial<T>;
  /** Field names that were present and silently dropped. */
  rejected: string[];
}

/**
 * Mass-assignment defence.
 *
 * The threat is a request that carries more than it should — `{"displayName":"x",
 * "role":"ADMIN"}` — reaching an update that spreads the whole body into a row. Filtering
 * against an explicit allowlist means an attacker can only ever set fields someone chose
 * to expose, and adding a sensitive column later cannot accidentally make it writable.
 *
 * Rejected fields are returned rather than thrown on, because the right response is to
 * apply the safe subset and RECORD the attempt: a request trying to set `role` is a
 * security signal worth keeping even though the request itself succeeds.
 */
export function applyAllowlist<T extends object>(
  input: Record<string, unknown>,
  allowed: ReadonlyArray<keyof T & string>,
): AllowlistResult<T> {
  const data: Record<string, unknown> = {};
  const rejected: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    if ((allowed as readonly string[]).includes(key)) {
      data[key] = value;
    } else {
      rejected.push(key);
    }
  }

  return { data: data as Partial<T>, rejected };
}

/** Fields whose presence in a request body is not a mistake but an attempt. */
const ESCALATION_FIELDS = new Set([
  "role",
  "roles",
  "isadmin",
  "is_admin",
  "admin",
  "permissions",
  "did",
  "didhash",
  "did_hash",
  "address",
  "owner",
  "ownerdid",
  "id",
]);

export interface SecurityEventContext {
  requestId?: string;
  actor?: string;
  method: string;
  path: string;
}

/**
 * Records a mass-assignment attempt.
 *
 * Escalation-shaped fields are logged at `warn` and flagged, everything else at `info`.
 * A stray `updatedAt` is a sloppy client; a `role` is someone probing, and the two should
 * not compete for attention in the same alert stream.
 */
export function logRejectedFields(
  logger: Logger,
  rejected: readonly string[],
  context: SecurityEventContext,
): void {
  if (rejected.length === 0) return;

  const escalation = rejected.filter((field) => ESCALATION_FIELDS.has(field.toLowerCase()));

  logger.log({
    level: escalation.length > 0 ? "warn" : "info",
    msg: "security.mass_assignment_blocked",
    requestId: context.requestId,
    actor: context.actor,
    method: context.method,
    path: context.path,
    rejectedFields: [...rejected],
    escalationAttempt: escalation.length > 0,
    escalationFields: escalation,
  });
}
