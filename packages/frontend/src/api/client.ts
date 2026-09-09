import { apiBaseUrl } from "@/config/env";

/**
 * The single place the app talks to the API.
 *
 * Every request carries `credentials: "include"`, because the session is an httpOnly
 * cookie on a different origin — omitting it on one call makes that call silently
 * anonymous, which surfaces as a mystery 401 on one screen and nowhere else.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** The API's machine-readable `error` field, when it sent one. */
    readonly code: string | null,
    message: string,
    /**
     * Validation detail, when the API rejected the request shape.
     *
     * These were being thrown away, which is how the admin console spent its life showing
     * "invalid_request" and nothing else — while the server was saying, in the same
     * response, exactly which field was wrong. Server-generated and describing our own
     * request, so there is nothing here an attacker supplies.
     */
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Not signed in, or the session expired. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /** Signed in, but lacking the role or permission this route requires. */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  /** The server has no chain it can use. Distinct from "no data". */
  get isUnavailable(): boolean {
    return this.status === 503;
  }
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      credentials: "include",
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
  } catch {
    // A network failure is not an HTTP status. Status 0 keeps the shape uniform without
    // pretending the server answered.
    throw new ApiError(0, "network_error", "Cannot reach the API");
  }

  if (!response.ok) {
    let code: string | null = null;
    let issues: string[] = [];
    try {
      const body = (await response.json()) as { error?: unknown; issues?: unknown };
      if (typeof body.error === "string") code = body.error;
      if (Array.isArray(body.issues)) {
        issues = body.issues.filter((issue): issue is string => typeof issue === "string");
      }
    } catch {
      // A non-JSON error body is not itself an error worth surfacing.
    }

    throw new ApiError(
      response.status,
      code,
      code ?? `Request failed (${response.status})`,
      issues,
    );
  }

  return (await response.json()) as T;
}
