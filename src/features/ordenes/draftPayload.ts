// drafts.payload (jsonb) ⇄ OrderState. El draft es transitorio y retomable: guarda la
// orden completa + cliente/envío elegidos + ts de última actividad. Decoder tolerante
// (campos faltantes → defaults) para que un payload viejo nunca rompa la UI.
import type { Json } from "../../data/database.types";
import { blankOrder, type OrderLine, type OrderState } from "../../domain/orders";

export type DraftPayload = {
  order: OrderState;
  clientId: string | null;
  shipId: string | null;
  ts: number;
};

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function parseLine(raw: unknown): OrderLine {
  const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const line: OrderLine = {
    modelId: strOrNull(o["modelId"]),
    modelName: str(o["modelName"]),
    category: str(o["category"]),
    qty: num(o["qty"], 1),
    color: str(o["color"]),
    spec: str(o["spec"]),
    supplierId: strOrNull(o["supplierId"]),
    supplierName: str(o["supplierName"]),
    cost: num(o["cost"]),
    price: num(o["price"]),
    imei: str(o["imei"]),
    imeis: strArr(o["imeis"]),
    serials: strArr(o["serials"]),
  };
  const itemId = strOrNull(o["itemId"]);
  if (itemId) line.itemId = itemId;
  return line;
}

export function parseDraftPayload(raw: Json): DraftPayload {
  const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const ord = (o["order"] && typeof o["order"] === "object" && !Array.isArray(o["order"])
    ? o["order"]
    : {}) as Record<string, unknown>;
  const base = blankOrder(0);
  const order: OrderState = {
    items: Array.isArray(ord["items"]) ? ord["items"].map(parseLine) : [],
    invoiceNo: str(ord["invoiceNo"], base.invoiceNo),
    date: str(ord["date"], base.date),
    payment: str(ord["payment"], base.payment),
    fob: str(ord["fob"], base.fob),
    salesperson: str(ord["salesperson"]),
    job: str(ord["job"]),
    terms: str(ord["terms"], base.terms),
    dueDate: str(ord["dueDate"], base.dueDate),
    shippingCost: num(ord["shippingCost"]),
    deliveryAddr: str(ord["deliveryAddr"]),
    stage: str(ord["stage"], "cotizando"),
  };
  return {
    order,
    clientId: strOrNull(o["clientId"]),
    shipId: strOrNull(o["shipId"]),
    ts: num(o["ts"], Date.now()),
  };
}

export function serializeDraftPayload(p: DraftPayload): Json {
  // OrderState/OrderLine son JSON-serializables por construcción (strings/números/arrays)
  return JSON.parse(JSON.stringify(p)) as Json;
}
