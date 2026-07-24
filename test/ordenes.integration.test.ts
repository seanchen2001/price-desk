// Fase 6 — verificación del AC contra el Supabase REAL (service key): flujo end-to-end
// draft → facturar → invoice + invoice_items + invoice_item_units en la base → cargar
// IMEIs/series por unidad → editar la factura (reconciliación por fila) → soft-delete.
// Usa los modelos/proveedores demo sembrados en Fase 5 y crea un cliente/envío demo
// (quedan como demo idempotente); la factura y el draft del test se limpian al final.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { WebSocketLike, WebSocketLikeConstructor } from "@supabase/realtime-js";
import type { Database } from "../src/data/database.types";
import type { Db } from "../src/data/supabase";
import {
  blankOrder,
  buildClientPdf,
  buildImeiRows,
  dmyToISO,
  groupBySupplier,
  orderTotals,
  todayDMY,
  type OrderLine,
  type OrderState,
} from "../src/domain/orders";
import { costForQty, type PriceMatrix, type TierMatrix } from "../src/domain/planning";
import { parseDraftPayload, serializeDraftPayload } from "../src/features/ordenes/draftPayload";

// createClient exige un WebSocket en el entorno (Node < 22); stub tipado, jamás conecta.
class StubWebSocket implements WebSocketLike {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly readyState = 3;
  readonly url = "";
  readonly protocol = "";
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  close(): void {}
  send(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}
const stubTransport: WebSocketLikeConstructor = StubWebSocket;
(globalThis as { WebSocket?: unknown }).WebSocket ??= stubTransport;

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const envPath = fileURLToPath(new URL("../.env", import.meta.url));
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0 && !line.trim().startsWith("#")) {
        out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
    }
  }
  for (const k of ["VITE_SUPABASE_URL", "SUPABASE_SERVICE_KEY"]) {
    const v = process.env[k];
    if (v && !out[k]) out[k] = v;
  }
  return out;
}

const env = loadEnv();
const url = env["VITE_SUPABASE_URL"] ?? "";
const serviceKey = env["SUPABASE_SERVICE_KEY"] ?? "";
const hasEnv = url !== "" && serviceKey !== "";
const TIMEOUT = 30_000;

describe.skipIf(!hasEnv)("Fase 6 — Órdenes → factura + IMEIs por unidad (AC)", () => {
  let db: Db;
  let facturar: typeof import("../src/data/facturar");
  let invoicesRepo: typeof import("../src/data/invoices");
  let misc: typeof import("../src/data/misc");

  const stamp = `F6TEST-${Date.now()}`; // no NO numérico → no pisa la numeración real
  let clientId = "";
  let shipId = "";
  let planetId = "";
  let vitelId = "";
  let s26Id = "";
  let iphoneId = "";
  let invoiceId = "";
  let draftId = "";

  async function supplierId(name: string, code: string): Promise<string> {
    const found = await db.from("suppliers").select("id").eq("name", name).maybeSingle();
    if (found.error) throw found.error;
    if (found.data) return found.data.id;
    const ins = await db.from("suppliers").insert({ name, code }).select("id").single();
    if (ins.error) throw ins.error;
    return ins.data.id;
  }

  async function demoClientId(row: Database["public"]["Tables"]["clients"]["Insert"]): Promise<string> {
    const found = await db.from("clients").select("id").eq("name", row.name).maybeSingle();
    if (found.error) throw found.error;
    if (found.data) return found.data.id;
    const ins = await db.from("clients").insert(row).select("id").single();
    if (ins.error) throw ins.error;
    return ins.data.id;
  }

  async function demoShipId(row: Database["public"]["Tables"]["shippings"]["Insert"]): Promise<string> {
    const found = await db.from("shippings").select("id").eq("label", row.label).maybeSingle();
    if (found.error) throw found.error;
    if (found.data) return found.data.id;
    const ins = await db.from("shippings").insert(row).select("id").single();
    if (ins.error) throw ins.error;
    return ins.data.id;
  }

  async function modelIdByName(name: string): Promise<string> {
    const res = await db.from("models").select("id").eq("canonical_name", name).limit(1);
    if (res.error) throw res.error;
    const row = res.data[0];
    if (!row) throw new Error(`Falta el modelo demo de Fase 5: ${name} (corré mesa.integration primero)`);
    return row.id;
  }

  beforeAll(async () => {
    const { createClient } = await import("@supabase/supabase-js");
    db = createClient<Database>(url, serviceKey);
    facturar = await import("../src/data/facturar");
    invoicesRepo = await import("../src/data/invoices");
    misc = await import("../src/data/misc");

    // demo de Fase 5: modelos con precios/escala ya sembrados por mesa.integration
    s26Id = await modelIdByName("S26 12+512 5G DS");
    iphoneId = await modelIdByName("iPhone 17 Pro 256GB Blue");
    planetId = await supplierId("planET", "PL");
    vitelId = await supplierId("VITEL", "Vit");
    // asegurar el code corto del remito (columna suppliers.code)
    await db.from("suppliers").update({ code: "PL" }).eq("id", planetId);

    // asegurar precios base (por si la demo se corrió hace tiempo)
    await db.from("prices").upsert(
      [
        { model_id: s26Id, supplier_id: planetId, price: 620 },
        { model_id: s26Id, supplier_id: vitelId, price: 618 },
        { model_id: iphoneId, supplier_id: vitelId, price: 999 },
      ],
      { onConflict: "model_id,supplier_id" },
    );
    // escala del S26 en planET (20+ → 610, 50+ → 595) — tiers, jamás filas "(N pcs)"
    await db.from("price_tiers").upsert(
      [
        { model_id: s26Id, supplier_id: planetId, min_qty: 20, price: 610 },
        { model_id: s26Id, supplier_id: planetId, min_qty: 50, price: 595 },
      ],
      { onConflict: "model_id,supplier_id,min_qty" },
    );

    // cliente + envío demo (idempotentes, quedan como demo de la base)
    clientId = await demoClientId({
      name: "Cliente Demo Fase 6",
      address: "Av. Siempre Viva 742\nCiudad del Este",
      ruc: "80099887-1",
      phone: "0991 555 111",
      cuenta_corriente: true,
    });
    shipId = await demoShipId({
      label: "Depósito Demo Miami",
      notify: "Ojus LLC",
      direccion: "2100 NW 92nd Ave, Miami FL",
      telefono: "305 555 0100",
      contacto: "Juan",
    });
  }, TIMEOUT);

  afterAll(async () => {
    // limpiar lo efímero del test (el cliente/envío demo quedan)
    if (invoiceId) await db.from("invoices").delete().eq("id", invoiceId); // cascade items/units/ops
    if (draftId) await db.from("drafts").delete().eq("id", draftId);
  }, TIMEOUT);

  function buildOrder(): OrderState {
    // costo autocompletado con escala: 25 unidades del S26 en planET → tier 20+ = 610
    const prices: PriceMatrix = { [s26Id]: { [planetId]: 620, [vitelId]: 618 }, [iphoneId]: { [vitelId]: 999 } };
    const tiers: TierMatrix = {
      [s26Id]: { [planetId]: [{ min: 20, price: 610 }, { min: 50, price: 595 }] },
    };
    const s26Cost = costForQty(prices, tiers, s26Id, planetId, 25);
    expect(s26Cost).toBe(610); // la escala manda, no el precio base

    const items: OrderLine[] = [
      {
        modelId: s26Id,
        modelName: "S26 12+512 5G DS",
        category: "Samsung",
        qty: 25,
        color: "BLACK",
        spec: "",
        supplierId: planetId,
        supplierName: "planET",
        cost: s26Cost,
        price: 650,
        imei: "",
        imeis: ["356789012345671", "356789012345672"], // pegados pre-factura (parcial)
        serials: [],
      },
      {
        modelId: iphoneId,
        modelName: "iPhone 17 Pro 256GB Blue",
        category: "iPhone",
        qty: 2,
        color: "BLUE",
        spec: "",
        supplierId: vitelId,
        supplierName: "VITEL",
        cost: 999,
        price: 1080,
        imei: "",
        imeis: [],
        serials: [],
      },
    ];
    return { ...blankOrder(0), items, invoiceNo: stamp, date: todayDMY(), shippingCost: 120 };
  }

  it(
    "draft retomable: upsert a `drafts` y roundtrip del payload",
    async () => {
      const order = buildOrder();
      const payload = serializeDraftPayload({ order, clientId, shipId, ts: Date.now() });
      const row = await misc.upsertDraft({ payload }, db);
      draftId = row.id;
      const back = parseDraftPayload(row.payload);
      expect(back.order.items).toHaveLength(2);
      expect(back.order.items[0]!.modelId).toBe(s26Id);
      expect(back.order.items[0]!.imeis).toHaveLength(2);
      expect(back.clientId).toBe(clientId);
      // retomable: actualizar el mismo draft no crea otra fila
      const again = await misc.upsertDraft({ id: draftId, payload }, db);
      expect(again.id).toBe(draftId);
    },
    TIMEOUT,
  );

  it(
    "facturar: invoice + items (por model_id) + units + ops_tracking + snapshot client_pdf",
    async () => {
      const order = buildOrder();
      const totals = orderTotals(order.items, order.shippingCost);
      const clientRow = await db.from("clients").select("*").eq("id", clientId).single();
      if (clientRow.error) throw clientRow.error;
      const shipRow = await db.from("shippings").select("*").eq("id", shipId).single();
      if (shipRow.error) throw shipRow.error;
      const clientPdf = buildClientPdf(clientRow.data, shipRow.data, order.deliveryAddr);

      const { invoice, items } = await facturar.facturarOrder(
        { order, type: "factura", clientId, shipId, clientPdf },
        db,
      );
      invoiceId = invoice.id;

      // invoice: número visible, fecha ISO, totales y snapshot del cliente AL MOMENTO
      expect(invoice.no).toBe(stamp);
      expect(invoice.date).toBe(dmyToISO(order.date));
      expect(invoice.piezas).toBe(27);
      expect(Number(invoice.subtotal)).toBe(totals.subtotal);
      expect(Number(invoice.total)).toBe(totals.total);
      expect(Number(invoice.cost)).toBe(totals.cost);
      expect(Number(invoice.margin)).toBe(totals.margin);
      const snap = invoice.client_pdf as Record<string, unknown>;
      expect(snap["name"]).toBe("Cliente Demo Fase 6");
      expect(snap["notify"]).toBe("Ojus LLC");
      // order_meta persistido dentro del snapshot (re-descarga fiel del template)
      expect((snap["order_meta"] as Record<string, unknown>)["payment"]).toBe("W/T");

      // items por model_id (nunca por nombre)
      expect(items).toHaveLength(2);
      const dbItems = await invoicesRepo.listInvoiceItems(invoice.id, db);
      expect(dbItems.map((i) => i.model_id).sort()).toEqual([s26Id, iphoneId].sort());
      const s26Item = dbItems.find((i) => i.model_id === s26Id)!;
      expect(s26Item.qty).toBe(25);
      expect(Number(s26Item.cost)).toBe(610);
      expect(s26Item.supplier_id).toBe(planetId);

      // units: los 2 IMEIs pegados pre-factura ya están (una fila por unidad)
      const units = await invoicesRepo.listItemUnits(s26Item.id, db);
      expect(units.filter((u) => (u.imei ?? "").trim() !== "")).toHaveLength(2);

      // ops_tracking arranca en false (timeline post-venta)
      const ops = await misc.getOps(invoice.id, db);
      expect(ops).not.toBeNull();
      expect(ops!.afuera).toBe(false);
      expect(ops!.pago).toBe(false);

      // remito por proveedor: 2 grupos (planET / VITEL)
      expect(groupBySupplier(order.items)).toHaveLength(2);
    },
    TIMEOUT,
  );

  it(
    "IMEIs + series por unidad: setUnitsForItem reescribe las filas de UNA línea",
    async () => {
      const dbItems = await invoicesRepo.listInvoiceItems(invoiceId, db);
      const iphoneItem = dbItems.find((i) => i.model_id === iphoneId)!;
      await invoicesRepo.setUnitsForItem(
        {
          itemId: iphoneItem.id,
          qty: 2,
          imeis: ["013540001234567", "013540001234568"],
          serials: ["FX7ABC", "FX7ABD"],
        },
        db,
      );
      const units = await invoicesRepo.listItemUnits(iphoneItem.id, db);
      expect(units).toHaveLength(2);
      expect(units.map((u) => u.imei).sort()).toEqual(["013540001234567", "013540001234568"]);
      expect(units.map((u) => u.serial).sort()).toEqual(["FX7ABC", "FX7ABD"]);

      // filas del Excel desde la base: una por unidad, IMEI como string
      const rows = buildImeiRows([
        {
          modelName: "iPhone 17 Pro 256GB Blue",
          category: "iPhone",
          qty: 2,
          imeis: units.map((u) => u.imei ?? ""),
          serials: units.map((u) => u.serial ?? ""),
        },
      ]);
      expect(rows).toHaveLength(2);
      expect(rows[0]![1]).toBe("APPLE");
      expect(typeof rows[0]![3]).toBe("string");
    },
    TIMEOUT,
  );

  it(
    "editar la factura: reconciliación por fila (update qty, quitar línea) sin tocar units ajenas",
    async () => {
      const dbItems = await invoicesRepo.listInvoiceItems(invoiceId, db);
      const s26Item = dbItems.find((i) => i.model_id === s26Id)!;
      const order = buildOrder();
      // queda SOLO la línea S26 (el iPhone se quita), qty 30 → escala 20+ sigue en 610
      const line0 = order.items[0]!;
      const kept: OrderLine = { ...line0, itemId: s26Item.id, qty: 30, imeis: [], serials: [] };
      const edited: OrderState = { ...order, items: [kept] };
      const clientPdf = buildClientPdf({ name: "Cliente Demo Fase 6" }, null, "");
      const { invoice, items } = await facturar.updateInvoiceFromOrder(
        invoiceId,
        { order: edited, type: "factura", clientId, shipId, clientPdf },
        db,
      );
      expect(items).toHaveLength(1);
      expect(invoice.piezas).toBe(30);

      const after = await invoicesRepo.listInvoiceItems(invoiceId, db);
      expect(after).toHaveLength(1);
      expect(after[0]!.id).toBe(s26Item.id); // la fila se ACTUALIZÓ, no se recreó
      expect(after[0]!.qty).toBe(30);
      // las units de la línea conservada no se tocaron (imeis vacíos en la edición)
      const units = await invoicesRepo.listItemUnits(s26Item.id, db);
      expect(units.filter((u) => (u.imei ?? "").trim() !== "")).toHaveLength(2);
    },
    TIMEOUT,
  );

  it(
    "papelero: soft-delete saca la factura del listado sin borrar filas",
    async () => {
      await invoicesRepo.softDeleteInvoice(invoiceId, db);
      const listed = await invoicesRepo.listInvoices(db);
      expect(listed.some((i) => i.id === invoiceId)).toBe(false);
      const raw = await db.from("invoices").select("deleted_at").eq("id", invoiceId).single();
      if (raw.error) throw raw.error;
      expect(raw.data.deleted_at).not.toBeNull();
    },
    TIMEOUT,
  );
});
