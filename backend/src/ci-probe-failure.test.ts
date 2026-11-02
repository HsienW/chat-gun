import { expect, it } from "vitest";

it("fails on purpose to probe Backend CI", () => {
  expect(1).toBe(2);
});
