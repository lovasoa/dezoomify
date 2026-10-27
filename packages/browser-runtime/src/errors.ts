import type { Error as ErrorPayload } from "@dezoomify/wasm-bindings";

type Variant<K extends ErrorPayload["kind"]> = Extract<ErrorPayload, { kind: K }>;
type Fields<K extends ErrorPayload["kind"]> = Omit<Variant<K>, "kind">;
type TransportContext = Pick<Variant<"network-failure">, "transport" | "request">;

/** Runtime exceptions carry the generated Rust fields as enumerable facts.
 * Serialize explicitly at browser IPC boundaries: structured cloning an Error
 * can discard custom fields. Native causes and stacks stay local to diagnostics.
 * Constructors accept trusted facts; validate untrusted payloads before hydration. */
export class DezoomifyError<E extends ErrorPayload = ErrorPayload> extends Error {
  declare readonly kind: E["kind"];
  declare readonly detail?: string;
  declare readonly request?: string;

  constructor(payload: E, options?: ErrorOptions) {
    const message =
      "detail" in payload && payload.detail
        ? payload.detail
        : payload.kind === "http-error"
          ? `HTTP ${payload.status}${payload.request ? ` fetching ${payload.request}` : ""}`
          : payload.kind === "cancelled"
            ? "Operation cancelled"
            : payload.kind;
    super(message, options);
    for (const [key, value] of Object.entries(payload)) {
      // Wire facts cannot replace Error's methods or prototype. `cause` is also
      // a generated field on aggregate failures, so keep that one enumerable.
      if (key === "cause" || !(key in this))
        Object.defineProperty(this, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
    Object.defineProperty(this, "name", { value: new.target.name, configurable: true });
  }

  toJSON(): E {
    return { ...this } as unknown as E;
  }
}

export class InternalError extends DezoomifyError<Variant<"internal">> {
  constructor(detail: string, options?: ErrorOptions) {
    super({ kind: "internal", detail: detail.slice(0, 4096) }, options);
  }
}

export class InvalidInputError extends DezoomifyError<Variant<"invalid-input">> {
  constructor(detail: string) {
    super({ kind: "invalid-input", detail });
  }
}

export class CancelledError extends DezoomifyError<Variant<"cancelled">> {
  constructor() {
    super({ kind: "cancelled" });
  }
}

export class NetworkError
  extends DezoomifyError<Variant<"network-failure">>
  implements Variant<"network-failure">
{
  declare readonly transport: TransportContext["transport"];
  constructor(detail: string, context: TransportContext, options?: ErrorOptions) {
    super({ ...context, kind: "network-failure", detail: detail.slice(0, 4096) }, options);
  }
}

export class TimeoutError extends DezoomifyError<Variant<"timeout">> implements Variant<"timeout"> {
  declare readonly transport: TransportContext["transport"];
  constructor(detail: string, context: TransportContext) {
    super({ ...context, kind: "timeout", detail: detail.slice(0, 4096) });
  }
}

export class HttpError
  extends DezoomifyError<Variant<"http-error">>
  implements Variant<"http-error">
{
  declare readonly status: Variant<"http-error">["status"];
  declare readonly transport: Variant<"http-error">["transport"];
  declare readonly retry_after_ms?: Variant<"http-error">["retry_after_ms"];
  declare readonly preview?: Variant<"http-error">["preview"];
  constructor(fields: Fields<"http-error">, options?: ErrorOptions) {
    super({ ...fields, kind: "http-error" }, options);
  }
}

export class SizeLimitError
  extends DezoomifyError<Variant<"size-limit">>
  implements Variant<"size-limit">
{
  declare readonly max_bytes: Variant<"size-limit">["max_bytes"];
  constructor(maxBytes: number) {
    super({ kind: "size-limit", max_bytes: maxBytes });
  }
}

export class PolicyDeniedError
  extends DezoomifyError<Variant<"policy-denied">>
  implements Variant<"policy-denied">
{
  declare readonly blocked_reason: Variant<"policy-denied">["blocked_reason"];
  declare readonly transport: Variant<"policy-denied">["transport"];
  constructor(fields: Fields<"policy-denied">) {
    super({ ...fields, kind: "policy-denied" });
  }
}

export class ResourceError
  extends DezoomifyError<Variant<"resource">>
  implements Variant<"resource">
{
  declare readonly request: Variant<"resource">["request"];
  declare readonly resource_kind: Variant<"resource">["resource_kind"];
  declare readonly source: Variant<"resource">["source"];
  constructor(fields: Fields<"resource">) {
    super(
      { ...fields, kind: "resource", source: errorPayload(fields.source) },
      { cause: fields.source },
    );
  }
}

/** Reconstitute a validated wire failure without changing its kind or facts. */
export function errorFromPayload<E extends ErrorPayload>(payload: E): Error & E {
  return (payload instanceof DezoomifyError ? payload : new DezoomifyError(payload)) as Error & E;
}

/** Plain generated data for IPC; Error's native fields are intentionally local. */
export function errorPayload(error: ErrorPayload): ErrorPayload {
  return { ...error };
}
