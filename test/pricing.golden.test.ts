// GOLDEN de la planilla del trader — portado de seed-validation.test.mjs (repo viejo).
// Prueba que rowAggregates reproduce EXACTO las columnas Mínimo / Medio / 1.03 (cliente)
// de la planilla real. Los datos (catálogo, precios sembrados y referencia de la planilla)
// son fixtures transcriptos verbatim del viejo (price-logic.js + lib/seed-prices.js).
// NO tocar los valores: son la fuente de verdad de fidelidad.
import { describe, it, expect } from "vitest";
import { rowAggregates } from "../src/domain/pricing";

const MARGIN = 3; // su columna 1.03

const SUPPLIERS = ["planET", "mirgor", "VITEL", "SH", "Bax"];

// Catálogo estándar, nombres verbatim de la planilla del trader.
const CATALOG: { cat: string; name: string }[] = [
  { cat: "Samsung", name: "A06 4+64 DS" },
  { cat: "Samsung", name: "A07 4+64 DS" },
  { cat: "Samsung", name: "A07 4+128 DS" },
  { cat: "Samsung", name: "A16 4+128 DS" },
  { cat: "Samsung", name: "A17 4+128 DS" },
  { cat: "Samsung", name: "A26 8+256 5G DS" },
  { cat: "Samsung", name: "A36 6+128 5G DS" },
  { cat: "Samsung", name: "A36 8+256 5G DS" },
  { cat: "Samsung", name: "A37 6+128 5G DS" },
  { cat: "Samsung", name: "A37 8+256 5G DS" },
  { cat: "Samsung", name: "A56 8+128 5G DS" },
  { cat: "Samsung", name: "A56 8+256 5G DS" },
  { cat: "Samsung", name: "A56 12+256 5G DS" },
  { cat: "Samsung", name: "A57 8+128 5G DS" },
  { cat: "Samsung", name: "A57 8+256 5G DS" },
  { cat: "Samsung", name: "A57 12+256 5G DS" },
  { cat: "Samsung", name: "S25 FE 8+256 5G DS" },
  { cat: "Samsung", name: "S25 FE 8+512 5G DS" },
  { cat: "Samsung", name: "S25 ULTRA 12+256 5G DS" },
  { cat: "Samsung", name: "S25 ULTRA 12+512 5G DS" },
  { cat: "Samsung", name: "S25 ULTRA 12+1T 5G DS" },
  { cat: "Samsung", name: "S26 12/256GB 5G" },
  { cat: "Samsung", name: "S26 12/512GB 5G" },
  { cat: "Samsung", name: "S26 Plus 12/256GB 5G" },
  { cat: "Samsung", name: "S26 Plus 12/512GB 5G" },
  { cat: "Samsung", name: "S26 ULTRA 12/256GB 5G" },
  { cat: "Samsung", name: "S26 ULTRA 12/512GB 5G" },
  { cat: "Samsung", name: "S26 ULTRA 12/1TB 5G" },
  { cat: "Motorola LATIN", name: "Motorola G06 4+256" },
  { cat: "Motorola LATIN", name: "Motorola G15 4+256" },
  { cat: "Motorola LATIN", name: "Motorola G17 4+256" },
  { cat: "Motorola LATIN", name: "Motorola G35 4+256 5G" },
  { cat: "Motorola LATIN", name: "Motorola G56 8+256 5G" },
  { cat: "Motorola LATIN", name: "Motorola Edge 60 12+512" },
  { cat: "Motorola LATIN", name: "Motorola Edge 60 Fusion 8+256 5G" },
  { cat: "Motorola LATIN", name: "Motorola Edge 60 Pro 8+512 5G" },
  { cat: "Motorola LATIN", name: "Motorola Edge 70 Fusion 8+256 5G" },
  { cat: "Motorola LATIN", name: "Motorola Edge 70 Fusion 8+256 5G - FIFA2026" },
  { cat: "Motorola LATIN", name: "Motorola G86 PWR 8+256" },
  { cat: "Motorola EURO", name: "XT2535 G06 4+256" },
  { cat: "Motorola EURO", name: "XT2527 G86 8+256 5G" },
  { cat: "Motorola EURO", name: "XT2505 Edge 60 8+256" },
  { cat: "Motorola EURO", name: "XT2509 Edge 60 Neo 12+256" },
];

// Precios de proveedor sembrados, por SKU → proveedor (transcriptos de la planilla).
const SEED_PRICES: Record<string, Record<string, number>> = {
  "A06 4+64 DS": { planET: 84 },
  "A07 4+64 DS": { planET: 85, VITEL: 86, Bax: 82 },
  "A07 4+128 DS": { planET: 115, VITEL: 102, SH: 102, Bax: 94 },
  "A16 4+128 DS": { planET: 126 },
  "A17 4+128 DS": { planET: 131, VITEL: 135, SH: 135, Bax: 128 },
  "A26 8+256 5G DS": {},
  "A36 6+128 5G DS": { VITEL: 235, SH: 230 },
  "A36 8+256 5G DS": { planET: 252, VITEL: 262, SH: 260, Bax: 263 },
  "A37 6+128 5G DS": { planET: 252, VITEL: 262, SH: 260 },
  "A37 8+256 5G DS": { planET: 320, VITEL: 332, SH: 330, Bax: 315 },
  "A56 8+128 5G DS": {},
  "A56 8+256 5G DS": { planET: 326, Bax: 345 },
  "A56 12+256 5G DS": { planET: 343, SH: 355 },
  "A57 8+128 5G DS": { planET: 330, VITEL: 343, SH: 340 },
  "A57 8+256 5G DS": { VITEL: 382, SH: 380, Bax: 350 },
  "A57 12+256 5G DS": { SH: 380 },
  "S25 FE 8+256 5G DS": { planET: 505, SH: 495 },
  "S25 FE 8+512 5G DS": { planET: 541, SH: 530 },
  "S25 ULTRA 12+256 5G DS": {},
  "S25 ULTRA 12+512 5G DS": { planET: 788, VITEL: 795 },
  "S25 ULTRA 12+1T 5G DS": { planET: 833, VITEL: 845 },
  "S26 12/256GB 5G": { planET: 611, VITEL: 625 },
  "S26 12/512GB 5G": { planET: 741, VITEL: 760 },
  "S26 Plus 12/256GB 5G": { planET: 770, VITEL: 780 },
  "S26 Plus 12/512GB 5G": { VITEL: 910 },
  "S26 ULTRA 12/256GB 5G": { planET: 878, VITEL: 895 },
  "S26 ULTRA 12/512GB 5G": { planET: 1050, VITEL: 1040, Bax: 1020 },
  "S26 ULTRA 12/1TB 5G": { VITEL: 1235, Bax: 1200 },
  "Motorola G06 4+256": { mirgor: 100, VITEL: 102 },
  "Motorola G15 4+256": { mirgor: 116 },
  "Motorola G17 4+256": { mirgor: 138, SH: 137 },
  "Motorola G35 4+256 5G": { mirgor: 140 },
  "Motorola G56 8+256 5G": { VITEL: 185, SH: 185 },
  "Motorola Edge 60 12+512": { mirgor: 242 },
  "Motorola Edge 60 Fusion 8+256 5G": { mirgor: 230, VITEL: 230, SH: 210 },
  "Motorola Edge 60 Pro 8+512 5G": { VITEL: 375, SH: 365 },
  "Motorola Edge 70 Fusion 8+256 5G": { VITEL: 350, SH: 346 },
  "Motorola Edge 70 Fusion 8+256 5G - FIFA2026": { SH: 346 },
  "Motorola G86 PWR 8+256": { VITEL: 195 },
  "XT2535 G06 4+256": { mirgor: 97 },
  "XT2527 G86 8+256 5G": { mirgor: 180 },
  "XT2505 Edge 60 8+256": { mirgor: 226 },
  "XT2509 Edge 60 Neo 12+256": { mirgor: 255 },
};

// Valores autoritativos de la planilla del trader, solo para validación.
// { min, med, cli }  (cli = la columna 1.03 / cliente)
const SHEET_REF: Record<string, { min: number; med: number; cli: number }> = {
  "A06 4+64 DS": { min: 84, med: 84, cli: 87 },
  "A07 4+64 DS": { min: 82, med: 85, cli: 84 },
  "A07 4+128 DS": { min: 94, med: 102, cli: 97 },
  "A16 4+128 DS": { min: 126, med: 126, cli: 130 },
  "A17 4+128 DS": { min: 128, med: 133, cli: 132 },
  "A36 6+128 5G DS": { min: 230, med: 232.5, cli: 237 },
  "A36 8+256 5G DS": { min: 252, med: 261, cli: 260 },
  "A37 6+128 5G DS": { min: 252, med: 260, cli: 260 },
  "A37 8+256 5G DS": { min: 315, med: 325, cli: 324 },
  "A56 8+256 5G DS": { min: 326, med: 335.5, cli: 336 },
  "A56 12+256 5G DS": { min: 343, med: 349, cli: 353 },
  "A57 8+128 5G DS": { min: 330, med: 340, cli: 340 },
  "A57 8+256 5G DS": { min: 350, med: 380, cli: 361 },
  "S25 FE 8+256 5G DS": { min: 495, med: 500, cli: 510 },
  "S25 FE 8+512 5G DS": { min: 530, med: 535.5, cli: 546 },
  "S25 ULTRA 12+512 5G DS": { min: 788, med: 791.5, cli: 812 },
  "S25 ULTRA 12+1T 5G DS": { min: 833, med: 839, cli: 858 },
  "S26 12/256GB 5G": { min: 611, med: 618, cli: 629 },
  "S26 12/512GB 5G": { min: 741, med: 750.5, cli: 763 },
  "S26 Plus 12/256GB 5G": { min: 770, med: 775, cli: 793 },
  "S26 Plus 12/512GB 5G": { min: 910, med: 910, cli: 937 },
  "S26 ULTRA 12/256GB 5G": { min: 878, med: 886.5, cli: 904 },
  "S26 ULTRA 12/512GB 5G": { min: 1020, med: 1040, cli: 1051 },
  "S26 ULTRA 12/1TB 5G": { min: 1200, med: 1217.5, cli: 1236 },
  "Motorola G06 4+256": { min: 100, med: 101, cli: 103 },
  "Motorola G15 4+256": { min: 116, med: 116, cli: 119 },
  "Motorola G17 4+256": { min: 137, med: 137.5, cli: 141 },
  "Motorola G35 4+256 5G": { min: 140, med: 140, cli: 144 },
  "Motorola G56 8+256 5G": { min: 185, med: 185, cli: 191 },
  "Motorola Edge 60 12+512": { min: 242, med: 242, cli: 249 },
  "Motorola Edge 60 Fusion 8+256 5G": { min: 210, med: 230, cli: 216 },
  "Motorola Edge 60 Pro 8+512 5G": { min: 365, med: 370, cli: 376 },
  "Motorola Edge 70 Fusion 8+256 5G": { min: 346, med: 348, cli: 356 },
  "Motorola Edge 70 Fusion 8+256 5G - FIFA2026": { min: 346, med: 346, cli: 356 },
  "Motorola G86 PWR 8+256": { min: 195, med: 195, cli: 201 },
  "XT2535 G06 4+256": { min: 97, med: 97, cli: 100 },
  "XT2527 G86 8+256 5G": { min: 180, med: 180, cli: 185 },
  "XT2505 Edge 60 8+256": { min: 226, med: 226, cli: 233 },
  "XT2509 Edge 60 Neo 12+256": { min: 255, med: 255, cli: 263 },
};

describe("golden planilla — checks estructurales", () => {
  it("CATALOG sin nombres duplicados", () => {
    const names = CATALOG.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("SEED_PRICES solo tiene SKUs del catálogo y proveedores conocidos", () => {
    const names = new Set(CATALOG.map((c) => c.name));
    for (const sku of Object.keys(SEED_PRICES)) {
      expect(names.has(sku), `SKU fuera del catálogo: ${sku}`).toBe(true);
      for (const sp of Object.keys(SEED_PRICES[sku] ?? {}))
        expect(SUPPLIERS.includes(sp), `proveedor desconocido ${sp} en ${sku}`).toBe(true);
    }
  });
});

describe("golden planilla — rowAggregates reproduce Mínimo / Medio / cliente EXACTO", () => {
  // Filas que la planilla dejó sin precio ("REVIEW" en el viejo) simplemente no tienen
  // SHEET_REF y no se chequean, igual que en seed-validation.test.mjs.
  for (const { name: sku } of CATALOG) {
    const ref = SHEET_REF[sku];
    if (!ref) continue;
    it(sku, () => {
      const agg = rowAggregates(SEED_PRICES[sku] ?? {}, MARGIN);
      expect(agg.min, `${sku}: min`).toBe(ref.min);
      expect(agg.med, `${sku}: Medio`).toBe(ref.med);
      expect(agg.client, `${sku}: columna 1.03`).toBe(ref.cli);
      // cross-check independiente: su columna debe ser round(min * 1.03)
      expect(agg.client, `${sku}: client != round(min*1.03)`).toBe(Math.round(ref.min * 1.03));
    });
  }
});
