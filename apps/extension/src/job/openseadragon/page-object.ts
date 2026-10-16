import type { PageRealm } from "./types.ts";

const descriptor = Object.getOwnPropertyDescriptor;
const apply = Reflect.apply;

function unsignedInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

/** The only boundary that reads untrusted page values. Never invokes property getters.
 * Proxy traps are still page code; cooperative budgets cannot preempt them.
 */
export class PageObject {
  readonly identity: object;

  private constructor(identity: object) {
    this.identity = identity;
  }

  static from(value: unknown): PageObject | undefined {
    return value && (typeof value === "object" || typeof value === "function")
      ? new PageObject(value)
      : undefined;
  }

  private data(key: PropertyKey): unknown {
    try {
      return descriptor(this.identity, key)?.value;
    } catch {
      return undefined;
    }
  }

  reference(key: PropertyKey): PageObject | undefined {
    return PageObject.from(this.data(key));
  }

  matches(key: PropertyKey, value: boolean | object): boolean {
    return this.data(key) === value;
  }

  has(key: PropertyKey): boolean {
    return this.data(key) !== undefined;
  }

  truthy(key: PropertyKey): boolean {
    return !!this.data(key);
  }

  number(key: PropertyKey, fallback = 0): number {
    const value = this.data(key);
    return unsignedInteger(value) ? value : fallback;
  }

  string(key: PropertyKey, fallback = ""): string {
    const value = this.data(key);
    if (value === undefined) return fallback;
    if (typeof value !== "string" || value.length > 2048) throw new Error("unsupported string");
    return value;
  }

  boundedString(key: PropertyKey, max: number): string | undefined {
    const value = this.data(key);
    return typeof value === "string" && value.length <= max ? value : undefined;
  }

  isArray(key: PropertyKey): boolean {
    return Array.isArray(this.data(key));
  }

  private array(key: PropertyKey, max: number): unknown[] {
    const value = this.data(key);
    if (value === undefined) return [];
    const length = PageObject.from(value)?.number("length") ?? 0;
    if (!Array.isArray(value) || length > max) throw new Error("unsupported array");
    const array = PageObject.from(value);
    return Array.from({ length }, (_, index) => array?.data(index));
  }

  objects(key: PropertyKey, max: number): PageObject[] {
    return this.array(key, max).map((value) => {
      const object = PageObject.from(value);
      if (!object) throw new Error("unsupported array element");
      return object;
    });
  }

  arrayLength(key: PropertyKey, max: number): number {
    return this.array(key, max).length;
  }

  queryPresent(key: PropertyKey): boolean {
    const value = this.data(key);
    return !!(typeof value === "string" ? value : this.array(key, 1)[0]);
  }

  scaleFactors(key: PropertyKey): number[] {
    return this.array(key, 64).map((value) => {
      if (!unsignedInteger(value) || value < 1) throw new Error("unsupported scale factor");
      return value;
    });
  }

  scalar(key: PropertyKey, max: number): string | number | undefined {
    const value = this.data(key);
    if (!value) return undefined;
    if ((typeof value !== "string" && typeof value !== "number") || String(value).length > max)
      throw new Error("unsupported scalar");
    return value;
  }

  keys(): PropertyKey[] {
    return Reflect.ownKeys(this.identity);
  }

  nativeFunction(): boolean {
    return (
      typeof this.identity === "function" &&
      apply(Function.prototype.toString, this.identity, []).includes("[native code]")
    );
  }

  registry(realm: PageRealm): Iterable<PageObject> | undefined {
    const registry = this.reference("_viewers")?.identity;
    if (!(registry instanceof realm.Map)) return undefined;
    const values: IterableIterator<unknown> = apply(realm.Map.prototype.values, registry, []);
    return {
      *[Symbol.iterator]() {
        for (const value of values) {
          const object = PageObject.from(value);
          if (object) yield object;
        }
      },
    };
  }
}

export class PageAccess {
  private readonly nodeType = descriptor(Node.prototype, "nodeType")?.get;
  private readonly ownerDocument = descriptor(Node.prototype, "ownerDocument")?.get;

  realm(win: Window): PageRealm {
    return win as PageRealm;
  }

  element(value: PageObject | undefined): Element | undefined {
    try {
      return value && this.nodeType && apply(this.nodeType, value.identity, []) === 1
        ? (value.identity as Element)
        : undefined;
    } catch {
      return undefined;
    }
  }

  document(element: Element, fallback: Document): Document {
    return this.ownerDocument ? (apply(this.ownerDocument, element, []) as Document) : fallback;
  }
}

interface ElementProbe {
  captured: PageObject[];
  dispatch(element: Element, accept: (value: PageObject) => boolean): void;
}

export function createElementProbe(realm: PageRealm, limit: number): ElementProbe | undefined {
  const proto = realm.Function.prototype;
  const saved = descriptor(proto, "apply");
  if (!saved?.writable || !PageObject.from(saved.value)?.nativeFunction()) return undefined;
  const captured: PageObject[] = [];
  const dispatch: ElementProbe["dispatch"] = (element, accept) => {
    const event = new realm.KeyboardEvent("keydown", { key: "Unidentified", bubbles: false });
    // Installation, dispatch, and restoration are one synchronous operation.
    try {
      Object.defineProperty(proto, "apply", {
        ...saved,
        value: function (this: unknown, receiver: unknown, args: unknown) {
          const candidate = PageObject.from(receiver);
          if (
            PageObject.from(args)?.reference(0)?.matches("originalEvent", event) &&
            candidate &&
            accept(candidate)
          ) {
            if (captured.length < limit) captured.push(candidate);
            return true;
          }
          return apply(saved.value, this, [receiver, args]);
        },
      });
      element.dispatchEvent(event);
    } finally {
      Object.defineProperty(proto, "apply", saved);
    }
  };
  return { captured, dispatch };
}
