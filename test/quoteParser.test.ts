// Fase 5 — parser de texto plano (sin IA). Contrato: pliega variantes de cantidad en
// UNA entrada con tiers (jamás filas separadas) y no traga líneas ilegibles.
import { describe, it, expect } from "vitest";
import { parseQuoteText } from "../src/domain/quoteParser";
import { normalize } from "../src/domain/normalize";

describe("parseQuoteText", () => {
  it("línea simple 'MODELO precio'", () => {
    const { entries, unparsed } = parseQuoteText("S26 12+512 5G DS 620");
    expect(unparsed).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      rawName: "S26 12+512 5G DS",
      price: 620,
      tiers: [],
    });
  });

  it("separadores tolerados: ':', '-', '·', '$', usd", () => {
    const { entries, unparsed } = parseQuoteText(
      [
        "A07 4+128 DS: 94",
        "Motorola G06 4+256 - $100",
        "A16 4+128 DS · 98 usd",
        "• A17 4+128 DS 105",
      ].join("\n"),
    );
    expect(unparsed).toEqual([]);
    expect(entries.map((e) => e.price)).toEqual([94, 100, 98, 105]);
    expect(entries.map((e) => e.rawName)).toEqual([
      "A07 4+128 DS",
      "Motorola G06 4+256",
      "A16 4+128 DS",
      "A17 4+128 DS",
    ]);
  });

  it("pliega '(20 pcs)' / '(50+ pcs)' / base en UNA entrada con tiers (el fix central)", () => {
    const { entries } = parseQuoteText(
      [
        "S26 12+512 5G DS (20 pcs) 610",
        "S26 12+512 5G DS (50+ pcs) 595",
        "Galaxy S26 12+512 5G DS 620", // "Galaxy " + sin cantidad → mismo alias_key
      ].join("\n"),
    );
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    // todas las variantes comparten la clave de identidad
    expect(e.aliasKey).toBe(normalize("S26 12+512 5G DS"));
    // escalera completa (base min_qty=1) y precio = el más barato (semántica del viejo)
    expect(e.tiers).toEqual([
      { min_qty: 1, price: 620 },
      { min_qty: 20, price: 610 },
      { min_qty: 50, price: 595 },
    ]);
    expect(e.price).toBe(595);
    // el nombre representativo es la línea SIN cantidad
    expect(e.rawName).toBe("Galaxy S26 12+512 5G DS");
    expect(e.lines).toHaveLength(3);
  });

  it("rangos '(1-20 pcs)' → min_qty = límite inferior", () => {
    const { entries } = parseQuoteText(
      ["A56 8+256 5G DS (1-20 pcs) 240", "A56 8+256 5G DS (21-49 pcs) 232"].join("\n"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.tiers).toEqual([
      { min_qty: 1, price: 240 },
      { min_qty: 21, price: 232 },
    ]);
  });

  it("US SPECS y paréntesis de código no bifurcan la identidad", () => {
    const { entries } = parseQuoteText(
      ["iPhone 17 Pro 256GB Blue US Specs 999", "iPhone 17 Pro 256GB Blue (A3101) 1005"].join(
        "\n",
      ),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.aliasKey).toBe(normalize("iPhone 17 Pro 256GB Blue"));
    // mismo escalón (min_qty 1) repetido → gana la última línea
    expect(entries[0]!.price).toBe(1005);
    expect(entries[0]!.tiers).toEqual([]);
  });

  it("precios con miles: '1.500' (AR) y '1,500' (EN)", () => {
    const { entries } = parseQuoteText(
      ["iPhone 18 Fold 1TB 1.500", "MacBook Air M5 16+512 1,299"].join("\n"),
    );
    expect(entries.map((e) => e.price)).toEqual([1500, 1299]);
  });

  it("líneas ilegibles van a `unparsed` (visibles, nunca tragadas)", () => {
    const { entries, unparsed } = parseQuoteText(
      ["hola buen día!", "S26 12+256 5G 560", "1234", ""].join("\n"),
    );
    expect(entries).toHaveLength(1);
    expect(unparsed).toEqual(["hola buen día!", "1234"]);
  });
});
