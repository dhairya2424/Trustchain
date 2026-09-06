/**
 * OpenZeppelin Defender Action (formerly Autotask), triggered by the Monitor defined in
 * sentinel-role-and-mint.json.
 *
 * Fires on two event classes that a compromise would have to produce:
 *
 *   RoleGranted / RoleRevoked / PermissionUpdated  someone changed who can do what
 *   AssetMinted                                    a new asset entered circulation
 *
 * Deliberately no dependencies beyond Defender's own runtime — this file is pasted or
 * uploaded as-is, and a build step between the source you review and the code that runs
 * in production is exactly the kind of gap monitoring is meant to close.
 *
 * Secrets (the webhook URL) come from Defender's secret store via `event.secrets`, never
 * from this file.
 */

/**
 * Role name by keccak256 of the role string. Verified against the contracts with
 * `keccak256(toUtf8Bytes(role))`; regenerate if a role is ever renamed, or alerts will
 * report a raw hash instead of a name at exactly the moment someone needs to read them.
 */
const ROLE_NAMES = {
  "0x0000000000000000000000000000000000000000000000000000000000000000": "DEFAULT_ADMIN_ROLE", // secrets-scan:allow
  "0xa49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775": "ADMIN_ROLE", // secrets-scan:allow
  "0x241ecf16d79d0f8dbfb92cbc07fe17840425976cf0667f022fe9877caa831b08": "MANAGER_ROLE", // secrets-scan:allow
  "0x59a1c48e5837ad7a7f3dcedcbe129bf3249ec4fbf651fd4f5e2600ead39fe2f5": "AUDITOR_ROLE", // secrets-scan:allow
  "0x14823911f2da1b49f045a0929a60b8c1f2a7fc8c06c7284ca3e8ab4e193a08c8": "USER_ROLE", // secrets-scan:allow
};

/** Events that must always page a human, regardless of who triggered them. */
const CRITICAL_EVENTS = new Set(["RoleGranted", "RoleRevoked", "PermissionUpdated"]);

function describe(reason) {
  const name = reason.signature ? reason.signature.split("(")[0] : "UnknownEvent";
  const params = reason.params || {};

  if (name === "RoleGranted" || name === "RoleRevoked") {
    const role = ROLE_NAMES[params.role] || params.role;
    const verb = name === "RoleGranted" ? "granted to" : "revoked from";
    return {
      name,
      severity: role === "DEFAULT_ADMIN_ROLE" || role === "ADMIN_ROLE" ? "critical" : "high",
      summary: `${role} ${verb} ${params.account} by ${params.sender}`,
    };
  }

  if (name === "PermissionUpdated") {
    return {
      name,
      severity: "critical",
      summary: `permission ${params.permission} on role ${ROLE_NAMES[params.role] || params.role} set to ${params.allowed} by ${params.updatedBy}`,
    };
  }

  if (name === "AssetMinted") {
    return {
      name,
      severity: "info",
      summary: `token #${params.tokenId} minted to DID ${params.ownerDID} by ${params.mintedBy}`,
    };
  }

  return { name, severity: "info", summary: JSON.stringify(params) };
}

exports.handler = async function handler(event) {
  const matches = (event.request && event.request.body && event.request.body.matchReasons) || [];
  const transaction = (event.request && event.request.body && event.request.body.transaction) || {};
  const sentinel = (event.request && event.request.body && event.request.body.sentinel) || {};

  const findings = matches.map(describe);
  if (findings.length === 0) return { handled: 0 };

  const critical = findings.filter((f) => f.severity === "critical" || CRITICAL_EVENTS.has(f.name));

  const payload = {
    text:
      `*TrustChain ${critical.length > 0 ? "CRITICAL" : "activity"}* on ${sentinel.network || "unknown network"}\n` +
      findings.map((f) => `• [${f.severity}] ${f.name}: ${f.summary}`).join("\n") +
      `\ntx: ${transaction.transactionHash || "n/a"}`,
  };

  const webhook = event.secrets && event.secrets.ALERT_WEBHOOK_URL;
  if (!webhook) {
    // Fail loudly rather than silently dropping an alert about a role change.
    throw new Error("ALERT_WEBHOOK_URL secret is not configured in Defender");
  }

  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`alert webhook returned ${response.status}`);
  }

  return { handled: findings.length, critical: critical.length };
};
