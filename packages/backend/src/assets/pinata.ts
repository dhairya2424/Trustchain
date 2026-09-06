export interface PinnedFile {
  cid: string;
  /** ipfs:// URI recorded on-chain. Gateway-independent by design. */
  uri: string;
  /** Dedicated-gateway URL, for display only. */
  gatewayUrl: string;
  size: number;
}

export interface IpfsPinner {
  pinFile(file: { buffer: Buffer; filename: string; mime: string }): Promise<PinnedFile>;
  pinJson(value: unknown, name: string): Promise<PinnedFile>;
}

export class PinningError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PinningError";
  }
}

const PINATA_FILE_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";
const PINATA_JSON_URL = "https://api.pinata.cloud/pinning/pinJSONToIPFS";

/**
 * Pins content to IPFS through Pinata.
 *
 * The on-chain tokenURI is always `ipfs://<cid>`, never a gateway URL. A gateway is one
 * company's HTTP endpoint; the CID is the content itself. Recording a gateway URL
 * on-chain would make a permanent record depend on a vendor staying online, and the URI
 * is immutable once minted.
 *
 * The JWT is read from configuration and sent only to Pinata. `fetch` is injected so
 * tests exercise both success and failure without network access.
 */
export class PinataClient implements IpfsPinner {
  constructor(
    private readonly options: { jwt: string; gateway: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private gatewayUrl(cid: string): string {
    return `${this.options.gateway.replace(/\/$/, "")}/ipfs/${cid}`;
  }

  private async send(url: string, body: FormData | string, headers: Record<string, string> = {}) {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.jwt}`, ...headers },
        body,
      });
    } catch (error) {
      throw new PinningError(
        `pinning request failed: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }

    if (!response.ok) {
      // Deliberately does not echo the response body: a provider error can contain the
      // request headers, and those carry the JWT.
      throw new PinningError(`pinning rejected with ${response.status}`, response.status);
    }

    const result = (await response.json()) as { IpfsHash?: string; PinSize?: number };
    if (!result.IpfsHash) throw new PinningError("pinning response contained no CID");

    return result;
  }

  async pinFile(file: { buffer: Buffer; filename: string; mime: string }): Promise<PinnedFile> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(file.buffer)], { type: file.mime }),
      file.filename,
    );
    form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

    const result = await this.send(PINATA_FILE_URL, form);
    const cid = result.IpfsHash as string;

    return {
      cid,
      uri: `ipfs://${cid}`,
      gatewayUrl: this.gatewayUrl(cid),
      size: result.PinSize ?? file.buffer.length,
    };
  }

  async pinJson(value: unknown, name: string): Promise<PinnedFile> {
    const body = JSON.stringify({
      pinataContent: value,
      pinataMetadata: { name },
      pinataOptions: { cidVersion: 1 },
    });

    const result = await this.send(PINATA_JSON_URL, body, {
      "content-type": "application/json",
    });
    const cid = result.IpfsHash as string;

    return {
      cid,
      uri: `ipfs://${cid}`,
      gatewayUrl: this.gatewayUrl(cid),
      size: result.PinSize ?? body.length,
    };
  }
}
