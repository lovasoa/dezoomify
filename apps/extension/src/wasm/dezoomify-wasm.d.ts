export default function init(): Promise<void>;

export class Session {
  constructor(protocolVersion: string, quotasJson: string);
  drainMessages(): string;
  dispatch(command: Uint8Array): void;
  allocateBuffer(length: number): string;
  writeBuffer(handle: string, offset: number, bytes: Uint8Array): void;
  commitBuffer(handle: string, length: number): void;
  protocolHandle(handle: string): string;
  dispose(): void;
}

export function rankCandidates(urlsJson: string): string;

export class DiscoverySession {
  constructor(sourceUrl: string);
  nextNeed(): string;
  provide(id: number | string, bytes: Uint8Array, finalUrl: string): void;
  provideFailure(id: number | string, message: string): void;
  finish(): string;
  levelTiles(image: string | number, level: number): string;
  probeSubmit(image: string | number, level: number, valid: boolean, width: number, height: number): string;
  applyProcessing(recipe: string, bytes: Uint8Array): Uint8Array;
}
