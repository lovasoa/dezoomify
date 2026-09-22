/** Exhaustive handler table for a generated discriminated union. */
export type DispatchTable<Union extends { type: string }, Result> = {
  [Type in Union["type"]]: (value: Extract<Union, { type: Type }>) => Result;
};

/**
 * Dispatch a generated union through its discriminant. TypeScript verifies
 * every key and gives each handler its exact variant.
 */
export function dispatchTyped<Union extends { type: string }, Result>(
  table: DispatchTable<Union, Result>,
  value: Union,
): Result {
  const type = value.type as Union["type"];
  const handler = table[type] as (variant: Union) => Result;
  return handler(value);
}
