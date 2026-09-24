export type JobBinding = {
  jobId: string;
  tabId: number;
  frameId: number;
  documentGeneration: number;
};

export type RuntimeMessage = { [key: string]: unknown; type: string };

export type SourceFetchReply =
  | { ok: true; status: number; url: string; bytes: number; data: string }
  | { ok: false; code: string; status?: number };

export const SOURCE_FETCH_BASE64_CHAR_LIMIT = 11_184_812;

export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
  );
}
