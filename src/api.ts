import { hostname, platform } from "node:os";
import { INGEST_VERSION, type CollectedSession } from "./readers/types.js";
import { VERSION } from "./version.js";

export type IngestResponse = {
  ok: true;
  sessions: number;
  events: number;
  watermark: string | null;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 5xx and network failures are worth retrying; 4xx are not. */
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export async function verify(url: string, token: string): Promise<void> {
  const res = await request(`${url}/api/ingest`, token, "GET");
  await drain(res);
}

export async function upload(
  url: string,
  token: string,
  sessions: CollectedSession[],
): Promise<IngestResponse> {
  const res = await request(`${url}/api/ingest`, token, "POST", {
    version: INGEST_VERSION,
    collectorVersion: VERSION,
    machine: { hostname: hostname(), os: platform() },
    sessions,
  });
  return (await res.json()) as IngestResponse;
}

async function request(
  endpoint: string,
  token: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // DNS failure, refused connection, TLS error — the server may simply be
    // down, and `Security.tsx` promises the collector backfills later.
    throw new ApiError(
      `Could not reach ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
      0,
      true,
    );
  }

  if (!res.ok) {
    const detail = await res
      .json()
      .then((j) => (j as { error?: string })?.error)
      .catch(() => null);
    throw new ApiError(
      detail || `${method} ${endpoint} failed with ${res.status}`,
      res.status,
      res.status >= 500 || res.status === 429,
    );
  }

  return res;
}

async function drain(res: Response): Promise<void> {
  try {
    await res.json();
  } catch {
    // Body is irrelevant on success paths that don't use it.
  }
}
