export interface ResolvedVariant {
  url: string;
  codec: "h264" | "hevc" | "bytevc2";
  quality: string;
  userAgent: string;
  contentKey?: string;
}

export interface DeviceIdentity {
  device_id: string;
  iid: string;
  cdid: string;
}

export interface UpstreamFetchRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array | null;
  timeoutMs?: number;
}

export interface UpstreamFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export type UpstreamTransport = (
  request: UpstreamFetchRequest,
  signal?: AbortSignal,
) => Promise<UpstreamFetchResponse>;

export class SourceResolverError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly incompleteEncryptionMetadata?: boolean;
  readonly minimumPixels?: number;

  constructor(
    code: string,
    message: string,
    extra?: {
      status?: number;
      incompleteEncryptionMetadata?: boolean;
      minimumPixels?: number;
    },
  ) {
    super(message);
    this.name = "SourceResolverError";
    this.code = code;
    this.status = extra?.status;
    this.incompleteEncryptionMetadata = extra?.incompleteEncryptionMetadata;
    this.minimumPixels = extra?.minimumPixels;
  }
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; name?: unknown };
  return e.code === "ERR_CANCELED" || e.name === "AbortError";
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new SourceResolverError("ERR_CANCELED", "已取消");
  }
}
