export interface TurnstileVerifier {
  verify(token: string, remoteIp?: string): Promise<boolean>;
}

/**
 * Cloudflare Turnstile bot check.
 *
 * A network call is injected rather than imported so the auth tests can drive both
 * outcomes deterministically. There is deliberately no "skip in development" escape
 * hatch: a bot check that can be turned off by an environment variable is one
 * misconfiguration away from not existing, and this one guards the login endpoint.
 */
export class CloudflareTurnstile implements TurnstileVerifier {
  constructor(
    private readonly secretKey: string,
    private readonly verifyUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async verify(token: string, remoteIp?: string): Promise<boolean> {
    if (!token) return false;

    const body = new URLSearchParams({ secret: this.secretKey, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);

    try {
      const response = await this.fetchImpl(this.verifyUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });

      if (!response.ok) return false;

      const result = (await response.json()) as { success?: boolean };
      return result.success === true;
    } catch {
      // Cloudflare unreachable means we cannot prove the caller is human. Failing closed
      // costs availability; failing open costs the protection entirely.
      return false;
    }
  }
}
