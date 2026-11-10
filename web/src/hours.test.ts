import { describe, expect, it } from "vitest";
import { compareHoursLeft, hoursLeftText } from "./hours.js";

describe("hoursLeftText", () => {
  it("says no seller deadline for null and keeps the h-left text for numbers", () => {
    expect(hoursLeftText(null)).toBe("no seller deadline");
    expect(hoursLeftText(12)).toBe("12 h left");
    expect(hoursLeftText(0)).toBe("0 h left");
  });
});

describe("compareHoursLeft", () => {
  const sortRows = (rows: Array<number | null>, desc = false) =>
    [...rows].sort((a, b) => (desc ? -1 : 1) * compareHoursLeft(a, b, undefined, undefined, desc));

  it("puts real deadlines first (ascending), null rows last", () => {
    expect(sortRows([null, 30, null, 5, 12])).toEqual([5, 12, 30, null, null]);
  });
  it("keeps null rows last when the grid sorts descending", () => {
    expect(sortRows([null, 30, 5, null], true)).toEqual([30, 5, null, null]);
  });
});
