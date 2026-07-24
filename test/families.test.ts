// Fase 5 — agrupación visual por familia (colores iPhone). PURO: no toca identidad.
import { describe, it, expect } from "vitest";
import { extractColor } from "../src/domain/colors";
import { groupFamilies } from "../src/domain/families";

type M = { id: string; name: string; min: number | null };
const cmp = (m: M) => String(m.min ?? "np");
const name = (m: M) => m.name;

describe("extractColor", () => {
  it("detecta color simple y multi-palabra, devuelve la base sin él", () => {
    expect(extractColor("iPhone 17 Pro 256GB Blue")).toEqual({
      color: "Blue",
      base: "iPhone 17 Pro 256GB",
    });
    expect(extractColor("iPhone 17 Pro Max 1TB Desert Titanium")).toEqual({
      color: "Desert Titanium",
      base: "iPhone 17 Pro Max 1TB",
    });
    expect(extractColor("iPhone 17 Naranja 256GB")).toEqual({
      color: "Naranja",
      base: "iPhone 17 256GB",
    });
  });
  it("sin color → base intacta", () => {
    expect(extractColor("S26 12+512 5G DS")).toEqual({ color: null, base: "S26 12+512 5G DS" });
  });
});

describe("groupFamilies", () => {
  const fam = (n: string, min: number | null, id: string): M => ({ id, name: n, min });

  it("familia uniforme colapsa en UNA fila", () => {
    const items = [
      fam("iPhone 17 Pro 256GB Blue", 999, "a"),
      fam("iPhone 17 Pro 256GB Silver", 999, "b"),
      fam("iPhone 17 Pro 256GB Black", 999, "c"),
    ];
    const out = groupFamilies(items, name, cmp);
    expect(out).toHaveLength(1);
    expect(out[0]!.familyName).toBe("iPhone 17 Pro 256GB");
    expect(out[0]!.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(out[0]!.colors).toEqual(["Blue", "Silver", "Black"]);
  });

  it("un color divergente se separa; el resto sigue plegado", () => {
    const items = [
      fam("iPhone 17 Pro 256GB Blue", 999, "a"),
      fam("iPhone 17 Pro 256GB Silver", 999, "b"),
      fam("iPhone 17 Pro 256GB Orange", 949, "c"), // Naranja más barato
      fam("iPhone 17 Pro 256GB Black", 999, "d"),
    ];
    const out = groupFamilies(items, name, cmp);
    expect(out).toHaveLength(2);
    expect(out[0]!.items.map((i) => i.id)).toEqual(["a", "b", "d"]);
    expect(out[0]!.colors).toEqual(["Blue", "Silver", "Black"]);
    expect(out[1]!.items.map((i) => i.id)).toEqual(["c"]);
    expect(out[1]!.familyName).toBe("iPhone 17 Pro 256GB Orange"); // nombre completo
  });

  it("familia de un solo modelo pasa directo (nombre completo, sin chip)", () => {
    const out = groupFamilies([fam("iPhone 17 Pro 256GB Blue", 999, "a")], name, cmp);
    expect(out).toEqual([
      { familyName: "iPhone 17 Pro 256GB Blue", items: [{ id: "a", name: "iPhone 17 Pro 256GB Blue", min: 999 }], colors: [] },
    ]);
  });

  it("modelos sin color no se mezclan entre sí (Samsung queda fila por fila)", () => {
    const items = [fam("S26 12+512 5G DS", 610, "a"), fam("S26 12+256 5G DS", 560, "b")];
    const out = groupFamilies(items, name, cmp);
    expect(out).toHaveLength(2);
  });

  it("distintas capacidades NO son la misma familia aunque compartan color", () => {
    const items = [
      fam("iPhone 17 Pro 256GB Blue", 999, "a"),
      fam("iPhone 17 Pro 512GB Blue", 1199, "b"),
    ];
    const out = groupFamilies(items, name, cmp);
    expect(out).toHaveLength(2);
  });
});
