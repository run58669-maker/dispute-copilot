/** Header text for the time left on a dispute; null means PayPal gave the seller no deadline. */
export function hoursLeftText(hoursLeft: number | null): string {
  return hoursLeft === null ? "no seller deadline" : `${hoursLeft} h left`;
}

/**
 * AG Grid comparator for the hours-left column: real deadlines first, null (no deadline) rows last,
 * in both sort directions. AG Grid negates the result when sorting descending, so pre-flip it for nulls.
 */
export function compareHoursLeft(a: number | null | undefined, b: number | null | undefined, _nodeA?: unknown, _nodeB?: unknown, isDescending?: boolean): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull || bNull) {
    const nullsLast = aNull ? 1 : -1;
    return isDescending ? -nullsLast : nullsLast;
  }
  return a - b;
}
