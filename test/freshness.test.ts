// Frescura semanal (vencimiento cada lunes) — portado de freshness.test.mjs (repo viejo).
import { describe, it, expect } from "vitest";
import { mondayStart, classifyFreshness, RECENT_MS } from "../src/domain/pricing";

const H = 3600 * 1000;

describe("mondayStart", () => {
  it("cae en lunes 00:00 de la misma semana, sobre 21 días arbitrarios", () => {
    for (let i = 0; i < 21; i++) {
      const d = new Date(2026, 5, 10 + i, 14, 30); // media tarde
      const ms = mondayStart(d);
      const m = new Date(ms);
      expect(m.getDay(), `mondayStart(${d.toDateString()}) debe caer lunes`).toBe(1);
      expect(m.getHours()).toBe(0);
      expect(m.getMinutes()).toBe(0);
      const delta = d.getTime() - ms;
      expect(delta).toBeGreaterThanOrEqual(0);
      expect(delta).toBeLessThan(7 * 24 * H);
    }
  });

  it("un lunes 00:00 mapea a sí mismo", () => {
    const aMonday = new Date(2026, 5, 22, 0, 0);
    expect(aMonday.getDay()).toBe(1); // sanity del fixture
    expect(mondayStart(aMonday)).toBe(aMonday.getTime());
  });
});

describe("classifyFreshness", () => {
  // anclar "now" a mitad de semana y derivar el ciclo
  const now = new Date(2026, 5, 24, 12, 0).getTime(); // miércoles al mediodía
  const cycle = mondayStart(new Date(now));

  it("timestamp faltante => expired", () => {
    expect(classifyFreshness(null, now)).toBe("expired");
  });
  it("anterior a este lunes => expired", () => {
    expect(classifyFreshness(cycle - 1 * H, now)).toBe("expired");
  });
  it("de este ciclo pero >24h => updated", () => {
    expect(classifyFreshness(cycle + 1 * H, now)).toBe("updated");
    expect(classifyFreshness(now - 25 * H, now)).toBe("updated");
  });
  it("<24h => recent", () => {
    expect(classifyFreshness(now - 1 * H, now)).toBe("recent");
    expect(classifyFreshness(now, now)).toBe("recent");
  });
  it("la ventana recent es de 24h", () => {
    expect(RECENT_MS).toBe(24 * H);
  });
  it("un precio del domingo a la noche está vencido el lunes a la mañana aunque tenga <24h (el corte de ciclo le gana a la recencia)", () => {
    const monMorning = new Date(2026, 5, 22, 8, 0);
    expect(monMorning.getDay()).toBe(1); // sanity del fixture
    const sunNight = monMorning.getTime() - 9 * H; // domingo ~23:00, <24h antes
    expect(classifyFreshness(sunNight, monMorning.getTime())).toBe("expired");
  });
});
