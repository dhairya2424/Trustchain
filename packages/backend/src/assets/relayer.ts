export interface MintRequest {
  toDID: string;
  tokenURI: string;
  soulbound: boolean;
}

export interface RelayedTransaction {
  transactionId: string;
  hash?: string;
  status: "pending" | "mined" | "failed";
}

export interface TransactionRelayer {
  relayMint(request: MintRequest): Promise<RelayedTransaction>;
}

export class RelayerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RelayerError";
  }
}

/**
 * Sends mint transactions through an OpenZeppelin Defender Relayer.
 *
 * The point is that the API holds no signing key at all. It presents an API credential
 * that authorises *requesting* a transaction; the private key lives in Defender's KMS and
 * never enters this process, its environment, or a heap dump. A fully compromised API
 * server can therefore ask for mints — which RoleAccessControl still has to authorise —
 * but cannot sign anything else, and cannot walk away with a key.
 *
 * Defender also handles nonce management and gas repricing, which is what stops
 * concurrent mints from colliding on a nonce.
 */
export class DefenderRelayer implements TransactionRelayer {
  constructor(
    private readonly options: {
      apiKey: string;
      apiSecret: string;
      relayerUrl: string;
      assetRegistryAddress: string;
    },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async relayMint(request: MintRequest): Promise<RelayedTransaction> {
    const body = JSON.stringify({
      to: this.options.assetRegistryAddress,
      // Defender encodes the call from the ABI signature; the API never builds calldata
      // or touches a key.
      functionName: "mint",
      args: [request.toDID, request.tokenURI, request.soulbound],
      speed: "fast",
    });

    let response: Response;
    try {
      response = await this.fetchImpl(this.options.relayerUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.options.apiKey,
          authorization: `Bearer ${this.options.apiSecret}`,
        },
        body,
      });
    } catch (error) {
      throw new RelayerError(
        `relayer unreachable: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }

    if (!response.ok) {
      // The body is not echoed: a relayer error can quote the request headers, which
      // carry the API secret.
      throw new RelayerError(
        `relayer rejected the transaction (${response.status})`,
        response.status,
      );
    }

    const result = (await response.json()) as {
      transactionId?: string;
      hash?: string;
      status?: string;
    };

    if (!result.transactionId) {
      throw new RelayerError("relayer response contained no transaction id");
    }

    return {
      transactionId: result.transactionId,
      ...(result.hash ? { hash: result.hash } : {}),
      status:
        result.status === "mined" ? "mined" : result.status === "failed" ? "failed" : "pending",
    };
  }
}
