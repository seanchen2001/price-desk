// Fase 6 — Excel IMEI+Serie con xlsx REAL: columnas exactas, celdas de IMEI/serie de
// tipo TEXTO (no número: Excel rompe IMEIs de 15 dígitos como numéricos) y roundtrip
// escribir → releer sin pérdida.
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { buildImeiWorkbook } from "../src/features/historial/imeiExcel";
import type { ImeiExportLine } from "../src/domain/orders";

const LINES: ImeiExportLine[] = [
  {
    modelName: "S26 12+512 5G DS",
    category: "Samsung",
    qty: 2,
    imeis: ["356789012345671", "356789012345672"],
    serials: ["R5CX10ABC", "R5CX10ABD"],
  },
  {
    modelName: "iPhone 17 Pro 256GB Blue",
    category: "iPhone",
    qty: 1,
    imeis: ["013540001234567"],
    serials: [],
  },
];

describe("buildImeiWorkbook", () => {
  const wb = buildImeiWorkbook(XLSX, LINES);
  const ws = wb.Sheets["IMEI-Serie"]!;

  it("hoja 'IMEI-Serie' con el header exacto", () => {
    expect(wb.SheetNames).toEqual(["IMEI-Serie"]);
    const header = ["A1", "B1", "C1", "D1", "E1"].map((a) => (ws[a] as { v: unknown }).v);
    expect(header).toEqual(["N°", "PRODUCTO", "MODELO", "IMEI", "NRO DE SERIE"]);
  });

  it("celdas de IMEI y serie son de tipo texto ('s'), nunca número", () => {
    for (const addr of ["D2", "D3", "D4", "E2", "E3"]) {
      const cell = ws[addr] as { t: string; v: unknown };
      expect(cell.t).toBe("s");
      expect(typeof cell.v).toBe("string");
    }
    // N° sí es numérico (contador 1..N)
    expect((ws["A2"] as { t: string }).t).toBe("n");
  });

  it("roundtrip escribir → releer: IMEIs de 15 dígitos intactos como texto", () => {
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    expect(buf.length).toBeGreaterThan(0);
    const back = XLSX.read(buf, { type: "buffer" });
    const sheet = back.Sheets["IMEI-Serie"]!;
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
    expect(rows).toHaveLength(3);
    expect(rows[0]!["IMEI"]).toBe("356789012345671");
    expect(rows[1]!["NRO DE SERIE"]).toBe("R5CX10ABD");
    // el IMEI con cero adelante NO se degradó a número
    expect(rows[2]!["IMEI"]).toBe("013540001234567");
    expect(rows[2]!["PRODUCTO"]).toBe("APPLE");
  });

  it("anchos de columna del viejo", () => {
    expect(ws["!cols"]).toEqual([{ wch: 5 }, { wch: 12 }, { wch: 26 }, { wch: 20 }, { wch: 20 }]);
  });
});
