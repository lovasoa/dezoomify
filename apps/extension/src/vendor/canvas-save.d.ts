export function canvasToPngBlob(canvas: { toBlob(cb: (blob: unknown | null) => void, mime?: string): void }): Promise<unknown>;
export function saveBlobViaAnchor(document: Document, blobUrl: string, width?: unknown, height?: unknown): void;
