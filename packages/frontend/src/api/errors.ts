/**
 * Turning failures into sentences a person can act on.
 *
 * The rule is that a raw error string never reaches the interface. Three kinds of text
 * would otherwise leak through, and each is bad for its own reason:
 *
 *   - **API error codes** (`actor_mismatch`, `no_usable_network`) are precise and
 *     meaningless to anyone who has not read the source.
 *   - **RPC and wallet errors** are worse: they are long, they name internals, and they
 *     frequently contain the literal string "execution reverted" followed by a hex blob.
 *     Showing that to a user tells them nothing and looks like a crash.
 *   - **Exception messages** we did not write, from libraries that assumed a developer
 *     would be reading them.
 *
 * So everything goes through here. Anything unrecognised falls back to a plain sentence
 * rather than the original text — deliberately losing information at the boundary, because
 * an unrecognised error is one we cannot promise is safe to display.
 *
 * The request id, where there is one, is what actually connects a user's report to a log
 * line, so it is surfaced separately rather than buried in the message.
 */

export interface HumanError {
  /** One sentence, addressed to the person reading it. */
  message: string;
  /** What they can do about it, when there is something. */
  action?: string;
  /** Shown small, for support. */
  requestId?: string | undefined;
}

const BY_CODE: Record<string, HumanError> = {
  // ---- session and authorization
  unauthenticated: {
    message: "You are not signed in.",
    action: "Connect your wallet and sign in to continue.",
  },
  // ---- sign-in
  field_validation_failed: {
    message: "The signature was bound to a different address bar than this one.",
    action:
      "Sign-In With Ethereum ties a signature to the exact domain your wallet displayed, so open the app at the address the server expects and sign in again.",
  },
  malformed_siwe_message: {
    message: "The sign-in message could not be read.",
    action: "Reload the page and try again.",
  },
  signature_mismatch: {
    message: "The signature did not match the address that sent it.",
    action: "Make sure your wallet is on the account you meant to use.",
  },
  forbidden: {
    message: "Your identity does not hold the permission this action needs.",
    action: "An administrator can grant it — the contract would refuse this too.",
  },
  invalid_or_expired_nonce: {
    message: "That sign-in request expired.",
    action: "Try connecting again — it takes a fresh one each time.",
  },
  bot_check_failed: {
    message: "The bot check did not pass.",
    action: "Reload the page and try again.",
  },
  too_many_failures: {
    message: "Too many failed attempts from this address.",
    action: "Wait for the cool-down to pass before trying again.",
  },
  rate_limited: {
    message: "Too many requests from this address.",
    action: "Wait a moment and try again.",
  },

  // ---- signing and relaying
  actor_mismatch: {
    message: "That signature belongs to a different account than the one signed in.",
    action: "Switch your wallet back to the signed-in account and retry.",
  },
  invalid_signature: {
    message: "The signature did not verify against this request.",
    action: "Sign again — the request may have changed between preparing and signing.",
  },
  request_expired: {
    message: "That signature expired before it was submitted.",
    action: "Try again — signed requests are only valid for a few minutes.",
  },
  target_not_allowed: {
    message: "That contract is not on the active network's allowlist.",
  },
  invalid_request: {
    message: "The request was rejected as malformed.",
  },
  invalid_cursor: {
    message: "That page link is no longer valid.",
    action: "Reapply the filters to start from the first page.",
  },

  // ---- chain availability
  no_usable_network: {
    message: "No blockchain network is currently usable, so nothing can be submitted.",
    action: "This is an availability problem, not a problem with what you asked for.",
  },
  registry_unavailable: {
    message: "The registry could not be reached, so this could not be checked.",
    action: "That is not a statement about the credential — try again shortly.",
  },
  network_error: {
    message: "Could not reach the API.",
    action: "Check that the backend is running, then try again.",
  },

  // ---- assets and credentials
  file_required: { message: "Choose a file before continuing." },
  asset_not_found: { message: "No asset exists with that id." },
  profile_not_found: { message: "No profile exists for this identity yet." },
};

/**
 * Patterns for errors that arrive as prose rather than a code.
 *
 * Wallet and RPC libraries do not offer stable codes for most of these, so matching text is
 * the only option. Ordered most-specific first; each is a phrase those libraries have used
 * consistently for long enough to rely on.
 */
const BY_PATTERN: { test: RegExp; error: HumanError }[] = [
  {
    test: /user (rejected|denied)|denied transaction signature|rejected the request/i,
    error: {
      message: "You declined the request in your wallet.",
      action: "Nothing was submitted. Try again when you are ready.",
    },
  },
  {
    /*
     * wagmi's ProviderNotFoundError, which surfaces as "Provider not found. Version:
     * @wagmi/core@3.6.5". It means only one thing — this browser has no wallet extension —
     * and it says none of it, while leaking a library version to someone who cannot use it.
     */
    test: /provider not found|no injected provider|window\.ethereum is undefined/i,
    error: {
      message: "No wallet extension was found in this browser.",
      action:
        "Install MetaMask or another Ethereum wallet and reload. Verifying a credential needs no wallet at all.",
    },
  },
  {
    test: /already pending|request of type .* already pending|resource unavailable/i,
    error: {
      message: "Your wallet is already showing a request.",
      action: "Open the wallet and respond to it, then try again.",
    },
  },
  {
    test: /connector not found|connector already connected/i,
    error: {
      message: "That wallet is not available to connect right now.",
      action: "Reload the page and try again.",
    },
  },
  {
    test: /insufficient funds|insufficient balance/i,
    error: {
      message: "The account paying for this transaction has no funds.",
      action: "On the local chain, run `node tools/fund-relayer.mjs`.",
    },
  },
  {
    test: /execution reverted/i,
    error: {
      message: "The contract refused this transaction.",
      action: "Usually that means the permission it checks is not held by your identity.",
    },
  },
  {
    test: /nonce too low|already known|replacement transaction underpriced/i,
    error: {
      message: "That transaction was already submitted.",
      action: "Wait for the pending one to confirm before sending another.",
    },
  },
  {
    test: /chain (id )?mismatch|wrong network|unsupported chain/i,
    error: {
      message: "Your wallet is connected to a different network than the platform is using.",
      action: "Switch networks in your wallet and try again.",
    },
  },
  {
    test: /failed to fetch|networkerror|load failed/i,
    error: {
      message: "Could not reach the API.",
      action: "Check that the backend is running, then try again.",
    },
  },
];

const FALLBACK: HumanError = {
  message: "Something went wrong.",
  action: "Try again; if it keeps happening, the request id below identifies this attempt.",
};

/**
 * The single entry point. Accepts anything — a code, an Error, an unknown thrown value.
 *
 * Never returns the original text for an unrecognised input. That is deliberate: an error
 * we have not classified is one we cannot promise is fit to show, and a stack trace or a
 * hex blob in the interface is worse than a plain sentence.
 */
export function humanError(input: unknown, requestId?: string | undefined): HumanError {
  const withId = (error: HumanError): HumanError => ({ ...error, requestId });

  if (typeof input === "string") {
    const known = BY_CODE[input];
    if (known) return withId(known);

    const matched = BY_PATTERN.find((entry) => entry.test.test(input));
    if (matched) return withId(matched.error);

    return withId(FALLBACK);
  }

  if (input instanceof Error) {
    const matched = BY_PATTERN.find((entry) => entry.test.test(input.message));
    if (matched) return withId(matched.error);

    // An Error whose message happens to be one of our codes — thrown by the API client.
    const known = BY_CODE[input.message];
    if (known) return withId(known);

    return withId(FALLBACK);
  }

  return withId(FALLBACK);
}

/** Convenience for the common case of rendering one line. */
export function humanErrorText(input: unknown): string {
  const { message, action } = humanError(input);
  return action ? `${message} ${action}` : message;
}
