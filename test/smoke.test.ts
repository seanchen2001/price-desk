import { describe, it, expect } from "vitest";

describe("andamiaje (Fase 1)", () => {
  it("vitest corre TS estricto", () => {
    const money = (n: number): string => n.toFixed(2);
    expect(money(1234.5)).toBe("1234.50");
  });
});
