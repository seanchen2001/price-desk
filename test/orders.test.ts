// Fase 6 — domain/orders: numeración, totales, remito por proveedor, snapshot de cliente
// y las filas del Excel IMEI+Serie (una fila por unidad). También el cableado de keys de
// Realtime para las tablas nuevas de la fase (invoice_item_units / drafts / shippings).
import { describe, expect, it } from "vitest";
import { keys, realtimeInvalidation } from "../src/data/keys";
import {
  blankOrder,
  brandFor,
  buildClientPdf,
  orderMetaOf,
  parseOrderMeta,
  buildImeiRows,
  dmyToISO,
  groupBySupplier,
  IMEI_EXPORT_HEADER,
  nextInvoiceNo,
  orderTotals,
  parseClientPdf,
  splitUnits,
  supplierFileCode,
  stageInfo,
} from "../src/domain/orders";

describe("nextInvoiceNo", () => {
  it("arranca en 2427 sin historial (igual que el viejo)", () => {
    expect(nextInvoiceNo([])).toBe(2427);
  });
  it("max + 1 ignorando nos no numéricos", () => {
    expect(nextInvoiceNo([{ no: "2430" }, { no: "2504" }, { no: "F6TEST-1" }, { no: null }])).toBe(2505);
  });
});

describe("orderTotals", () => {
  it("piezas / subtotal / costo / margen / total con envío", () => {
    const t = orderTotals(
      [
        { qty: 3, price: 620, cost: 600 },
        { qty: 2, price: 1000, cost: 950 },
      ],
      50,
    );
    expect(t).toEqual({
      piezas: 5,
      subtotal: 3 * 620 + 2 * 1000,
      shipping: 50,
      total: 3 * 620 + 2 * 1000 + 50,
      cost: 3 * 600 + 2 * 950,
      margin: 3 * 620 + 2 * 1000 - (3 * 600 + 2 * 950),
    });
  });
});

describe("groupBySupplier (remito por proveedor)", () => {
  it("agrupa por supplierId; sin proveedor va junto", () => {
    const items = [
      { supplierId: "a", supplierName: "planET" },
      { supplierId: "b", supplierName: "VITEL" },
      { supplierId: "a", supplierName: "planET" },
      { supplierId: null, supplierName: "" },
    ];
    const groups = groupBySupplier(items);
    expect(groups).toHaveLength(3);
    expect(groups.find((g) => g.supplierId === "a")?.items).toHaveLength(2);
    expect(groups.find((g) => g.supplierId === null)?.supplierName).toBe("(sin proveedor)");
  });
});

describe("supplierFileCode", () => {
  it("usa suppliers.code si existe; si no, el nombre saneado", () => {
    expect(supplierFileCode("PL", "planET")).toBe("PL");
    expect(supplierFileCode(null, "Mi Proveedor S.A.")).toBe("Mi_Proveedor_S_A_");
    expect(supplierFileCode("", null)).toBe("prov");
  });
});

describe("buildClientPdf", () => {
  it("precedencia de dirección: orden > envío > cliente; teléfono: envío > cliente", () => {
    const client = { name: "ACME", address: "Calle 1\nPiso 2", ruc: "80012345-6", phone: "0991" };
    const ship = { notify: "Ojus LLC", direccion: "Depósito Miami", telefono: "305", contacto: "Juan" };
    const full = buildClientPdf(client, ship, "Dirección explícita");
    expect(full.direccion).toBe("Dirección explícita");
    expect(full.telefono).toBe("305");
    expect(full.addressLines).toEqual(["Calle 1", "Piso 2"]);

    const sinOrden = buildClientPdf(client, ship, "");
    expect(sinOrden.direccion).toBe("Depósito Miami");

    const soloCliente = buildClientPdf(client, null, "");
    expect(soloCliente.direccion).toBe("Calle 1, Piso 2");
    expect(soloCliente.telefono).toBe("0991");
  });

  it("roundtrip por jsonb (parseClientPdf)", () => {
    const snap = buildClientPdf({ name: "ACME" }, { notify: "N" }, "D");
    expect(parseClientPdf(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
    expect(parseClientPdf(null).name).toBe("");
  });
});

describe("order_meta en el snapshot (re-descarga fiel)", () => {
  it("roundtrip por el jsonb client_pdf", () => {
    const order = {
      ...blankOrder(2504),
      payment: "CASH",
      fob: "Panamá",
      salesperson: "MG",
      terms: "Net 15",
      dueDate: "30/7/2026",
      deliveryAddr: "Depósito X",
    };
    const snap = { ...buildClientPdf({ name: "ACME" }, null, order.deliveryAddr), order_meta: orderMetaOf(order) };
    const back = parseOrderMeta(JSON.parse(JSON.stringify(snap)));
    expect(back.payment).toBe("CASH");
    expect(back.fob).toBe("Panamá");
    expect(back.terms).toBe("Net 15");
    expect(back.deliveryAddr).toBe("Depósito X");
    // snapshot viejo sin order_meta → defaults del template
    expect(parseOrderMeta({ name: "ACME" }).payment).toBe("W/T");
  });
});

describe("dmyToISO", () => {
  it("convierte la fecha del template a ISO para la columna date", () => {
    expect(dmyToISO("21/7/2026")).toBe("2026-07-21");
    expect(dmyToISO("3/12/25")).toBe("2025-12-03");
  });
  it("texto inválido cae a la fecha fallback", () => {
    const iso = dmyToISO("no es fecha", new Date(2026, 6, 24).getTime());
    expect(iso).toBe("2026-07-24");
  });
});

describe("Excel IMEI+Serie (filas por unidad)", () => {
  it("header exacto del viejo", () => {
    expect([...IMEI_EXPORT_HEADER]).toEqual(["N°", "PRODUCTO", "MODELO", "IMEI", "NRO DE SERIE"]);
  });

  it("una fila por unidad, contador global, marca derivada, IMEI/serie como string", () => {
    const rows = buildImeiRows([
      {
        modelName: "A07 4+64 DS",
        category: "Samsung",
        qty: 2,
        imeis: ["356789012345671", "356789012345672"],
        serials: ["R5CX1"],
      },
      { modelName: "iPhone 17 Pro 256GB Blue", category: "iPhone", qty: 1, imeis: [], serials: [] },
    ]);
    expect(rows).toEqual([
      [1, "SAMSUNG", "A07 4+64 DS", "356789012345671", "R5CX1"],
      [2, "SAMSUNG", "A07 4+64 DS", "356789012345672", ""],
      [3, "APPLE", "iPhone 17 Pro 256GB Blue", "", ""],
    ]);
    expect(typeof rows[0]![3]).toBe("string");
  });

  it("unidades = max(qty, imeis, serials): lo pegado de más no se pierde", () => {
    const rows = buildImeiRows([
      { modelName: "MOTO G100", category: "Motorola LATIN", qty: 1, imeis: ["1", "2", "3"], serials: [] },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]![1]).toBe("MOTOROLA");
  });

  it("brandFor cae a la categoría en mayúsculas", () => {
    expect(brandFor("Laptops", "Lenovo X1")).toBe("LAPTOPS");
    expect(brandFor("", "")).toBe("—");
  });
});

describe("splitUnits", () => {
  it("separa por renglón, trimea y descarta vacíos", () => {
    expect(splitUnits(" a \r\n\n b\nc ")).toEqual(["a", "b", "c"]);
    expect(splitUnits(null)).toEqual([]);
  });
});

describe("stageInfo", () => {
  it("id desconocido → primera etapa (Cotizando)", () => {
    expect(stageInfo("nope").id).toBe("cotizando");
    expect(stageInfo("enviada").label).toBe("Enviada");
  });
});

describe("Realtime keys (Fase 6)", () => {
  it("las tablas de la fase invalidan sus keys (Historial se refresca sin F5)", () => {
    const tables = realtimeInvalidation.map(([t]) => t);
    expect(tables).toContain("invoices");
    expect(tables).toContain("invoice_items");
    expect(tables).toContain("invoice_item_units");
    expect(tables).toContain("shippings");
    expect(tables).toContain("drafts");
    expect(tables).toContain("ops_tracking");
    const invoicesEntry = realtimeInvalidation.find(([t]) => t === "invoices");
    expect(invoicesEntry?.[1]).toEqual(keys.invoices);
  });
});
