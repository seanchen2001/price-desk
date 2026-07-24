// Cuentas corrientes derivadas: cargos desde las facturas + movimientos manuales del ledger.
// Débito suma al saldo, Crédito resta. Cliente: saldo = lo que nos debe. Proveedor: saldo =
// lo que le debemos. Portado de lib/accounts.js — misma matemática, REESCRITO por ID:
// las cuentas se keyean por party_id (client_id / supplier_id), no por nombre → desaparece
// el hack de `aliases` (canonName) del viejo; la identidad la da la FK, no el string.
// Función pura: la usan la UI y las tools del agente (con cualquier side).

export type Side = "client" | "supplier";

export type AccountsInvoice = {
  id: string;
  no: string; // número visible (para el concepto)
  type: string; // "factura" | "remito" — solo factura genera cargo
  ts?: number | null;
  date?: string | null; // "d/m/aaaa" (legacy) o ISO "aaaa-mm-dd" (schema nuevo)
  clientId?: string | null;
  total?: number | null;
  /** supplierId → costo total de esa factura con ese proveedor (la capa de datos lo
   *  deriva de invoice_items: Σ cost×qty por supplier_id). */
  supplierCosts?: Record<string, number | null | undefined> | null;
};

export type LedgerEntry = {
  id: string;
  ts?: number | null;
  // PORT-NOTE: el viejo filtraba por e.side; el schema trae side y party_type con la misma
  // semántica — acá se filtra por partyType (la que acompaña al party_id).
  partyType: Side;
  partyId: string;
  type: string; // pago | gasto | cargo
  amount?: number | null;
  concept?: string | null;
  date?: string | null;
  refInvoiceId?: string | null;
};

export type Movement = {
  key: string;
  id?: string; // solo movimientos manuales (fila de ledger)
  ts: number | null;
  date: string | null;
  concept: string;
  ref: string;
  cargo: number;
  pago: number;
  derived: boolean;
  when: number;
  saldo: number;
};

export type Account = { partyId: string; rows: Movement[]; saldo: number };

// PORT-NOTE: puerto de parseDMY (lib/helpers.js). El viejo solo entendía "d/m/aaaa"; el
// schema nuevo guarda `date` ISO ("aaaa-mm-dd"), así que se aceptan ambos con la misma
// semántica (medianoche local). Sin fecha parseable → fallback ts (o época 0), como el viejo.
export function parseWhen(date: string | null | undefined, fallbackTs?: number | null): number {
  const s = String(date ?? "");
  const dmy = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (dmy) {
    const y = +dmy[3]! < 100 ? 2000 + +dmy[3]! : +dmy[3]!;
    return new Date(y, +dmy[2]! - 1, +dmy[1]!).getTime();
  }
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return new Date(+iso[1]!, +iso[2]! - 1, +iso[3]!).getTime();
  return new Date(fallbackTs || 0).getTime();
}

type MovementInput = Omit<Movement, "saldo" | "when">;

export function computeAccounts(
  { invoices, ledger }: { invoices: readonly AccountsInvoice[]; ledger: readonly LedgerEntry[] },
  side: Side,
): Record<string, Account> {
  const byParty: Record<string, Omit<Movement, "saldo">[]> = {};
  // cargo = aumenta lo adeudado (venta al cliente / compra al proveedor); pago = lo reduce
  const add = (partyId: string, m: MovementInput) => {
    (byParty[partyId] ??= []).push({ ...m, when: parseWhen(m.date, m.ts) });
  };
  for (const f of invoices) {
    if (f.type !== "factura") continue;
    if (side === "client") {
      // PORT-NOTE: factura sin cliente asignado cae en la cuenta "—" (el viejo hacía lo
      // mismo con el nombre vacío). Las keys derivadas usan invoice.id (estable), no el nº.
      add(f.clientId ?? "—", {
        key: `f-${f.id}`,
        ts: f.ts ?? null,
        date: f.date ?? null,
        concept: `Factura #${f.no}`,
        ref: f.no,
        cargo: Number(f.total) || 0,
        pago: 0,
        derived: true,
      });
    } else {
      for (const [supplierId, c] of Object.entries(f.supplierCosts ?? {}))
        add(supplierId, {
          key: `f-${f.id}-${supplierId}`,
          ts: f.ts ?? null,
          date: f.date ?? null,
          concept: `Compra fact. #${f.no}`,
          ref: f.no,
          cargo: Number(c) || 0,
          pago: 0,
          derived: true,
        });
    }
  }
  for (const e of ledger) {
    if (e.partyType !== side) continue;
    if (e.type === "cargo" && e.refInvoiceId) continue; // cargos automáticos viejos → se derivan
    const pago = e.type === "pago";
    add(e.partyId, {
      key: e.id,
      id: e.id,
      ts: e.ts ?? null,
      date: e.date ?? null,
      concept: e.concept ?? "",
      ref: e.refInvoiceId ?? "",
      cargo: pago ? 0 : Number(e.amount) || 0,
      pago: pago ? Number(e.amount) || 0 : 0,
      derived: false,
    });
  }
  const out: Record<string, Account> = {};
  for (const [partyId, movs] of Object.entries(byParty)) {
    movs.sort((a, b) => a.when - b.when || (a.ts ?? 0) - (b.ts ?? 0)); // por fecha para el saldo corriente
    let saldo = 0;
    const rows = movs.map((m) => {
      saldo += (m.cargo || 0) - (m.pago || 0);
      return { ...m, saldo };
    });
    out[partyId] = { partyId, rows, saldo };
  }
  return out;
}
