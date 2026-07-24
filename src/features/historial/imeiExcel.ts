// Excel .xlsx de una factura: IMEI + Nº de serie, UNA fila por unidad física.
// Columnas: N° | PRODUCTO | MODELO | IMEI | NRO DE SERIE — IMEI/serie como TEXTO
// (celda tipo "s"), nunca número: Excel rompe los IMEIs de 15 dígitos si los toma
// como numéricos. SheetJS se carga on-demand (import dinámico, como el viejo).
import { buildImeiRows, IMEI_EXPORT_HEADER, type ImeiExportLine } from "../../domain/orders";
import type { WorkBook, WorkSheet } from "xlsx";

type XlsxModule = typeof import("xlsx");

/** Arma el workbook (separado del download para poder verificarlo en tests). */
export function buildImeiWorkbook(XLSX: XlsxModule, lines: readonly ImeiExportLine[]): WorkBook {
  const rows = buildImeiRows(lines);
  const ws: WorkSheet = XLSX.utils.aoa_to_sheet([[...IMEI_EXPORT_HEADER], ...rows]);
  // blindaje: IMEI (col D) y NRO DE SERIE (col E) SIEMPRE celdas de texto
  for (let r = 1; r <= rows.length; r++) {
    for (const col of ["D", "E"] as const) {
      const addr = `${col}${r + 1}`;
      const cell = ws[addr] as { t?: string; v?: unknown } | undefined;
      if (cell) {
        cell.t = "s";
        cell.v = String(cell.v ?? "");
      }
    }
  }
  ws["!cols"] = [{ wch: 5 }, { wch: 12 }, { wch: 26 }, { wch: 20 }, { wch: 20 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "IMEI-Serie");
  return wb;
}

/** Descarga `IMEI-Serie factura <no>.xlsx` (una fila por unidad). false = sin unidades. */
export async function exportImeiExcel(
  invoiceNo: string,
  lines: readonly ImeiExportLine[],
): Promise<boolean> {
  if (buildImeiRows(lines).length === 0) return false;
  const XLSX = await import("xlsx");
  const wb = buildImeiWorkbook(XLSX, lines);
  XLSX.writeFile(wb, `IMEI-Serie factura ${invoiceNo}.xlsx`);
  return true;
}
