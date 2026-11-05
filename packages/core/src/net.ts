export type RequestRole = "source" | "reader" | "issuer";
export type RequestRecord = { url: string; method: string; role: RequestRole; startedAt: number; durationMs: number; ok: boolean };
export type Transport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Injectable network boundary. The direct transport is for local development only. */
export class NetworkClient {
  private records: RequestRecord[] = [];
  constructor(private readonly transport: Transport = fetch) {}

  get requests(): readonly RequestRecord[] {
    return this.records;
  }

  async fetch(input: RequestInfo | URL, init: RequestInit = {}, role: RequestRole = "reader") {
    const startedAt = performance.now();
    try {
      const response = await this.transport(input, init);
      this.records.push({ url: String(input), method: init.method ?? "GET", role, startedAt, durationMs: performance.now() - startedAt, ok: response.ok });
      return response;
    } catch (error) {
      this.records.push({ url: String(input), method: init.method ?? "GET", role, startedAt, durationMs: performance.now() - startedAt, ok: false });
      throw error;
    }
  }
}

export const network = new NetworkClient();
