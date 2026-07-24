// Pulso de clientes — puerto de clientPulse (lib/accounts.js viejo), REESCRITO por ID:
// cruza saldo (computeAccounts) + post-venta pendiente (ops_tracking por invoice_id) +
// última compra. Excluye cuentas nuestras (es_nuestra). Ordenado por urgencia.
// Función PURA: la usa la tool client_pulse del agente (y es testeable sin base).
import { computeAccounts, parseWhen, type LedgerEntry } from "./accounts";
import type { DeskInvoice } from "./analytics";

export type PulseClient = { id: string; name: string; esNuestra: boolean };
export type PulseOps = { invoiceId: string; afuera: boolean; local: boolean; pago: boolean };

export type PulsePending = {
  factura: string;
  total: number;
  dias: number;
  falta: string[];
};

export type PulseEntry = {
  clientId: string;
  cliente: string;
  saldo: number;
  facturas: number;
  dias_sin_comprar: number | null;
  pendientes: PulsePending[];
  flags: string[];
};

export type PulseInputs = {
  invoices: readonly DeskInvoice[];
  ledger: readonly LedgerEntry[];
  clients: readonly PulseClient[];
  ops: readonly PulseOps[];
};

const DAY_MS = 86_400_000;

export function clientPulse(
  inputs: PulseInputs,
  clientQuery?: string,
  now: number = Date.now(),
): PulseEntry[] {
  const accs = computeAccounts({ invoices: inputs.invoices, ledger: inputs.ledger }, "client");
  const nameById = new Map(inputs.clients.map((c) => [c.id, c.name]));
  const own = new Set(inputs.clients.filter((c) => c.esNuestra).map((c) => c.id));
  const opsByInvoice = new Map(inputs.ops.map((o) => [o.invoiceId, o]));

  type Acc = { clientId: string; ultimaCompra: number; facturas: number; pendientes: PulsePending[] };
  const byClient = new Map<string, Acc>();
  for (const f of inputs.invoices) {
    if (f.type !== "factura") continue;
    const clientId = f.clientId ?? "—";
    if (own.has(clientId)) continue;
    const when = f.ts ?? parseWhen(f.date, f.ts);
    const c = byClient.get(clientId) ?? {
      clientId,
      ultimaCompra: 0,
      facturas: 0,
      pendientes: [],
    };
    if (!byClient.has(clientId)) byClient.set(clientId, c);
    c.facturas += 1;
    c.ultimaCompra = Math.max(c.ultimaCompra, when || 0);
    const t = opsByInvoice.get(f.id);
    const falta = [
      !t?.afuera && "entrega afuera",
      !t?.local && "entrega local",
      !t?.pago && "pago",
    ].filter((x): x is string => typeof x === "string");
    if (falta.length) {
      c.pendientes.push({
        factura: f.no,
        total: Number(f.total) || 0,
        dias: Math.floor((now - (when || now)) / DAY_MS),
        falta,
      });
    }
  }

  const out = [...byClient.values()]
    .map((c) => {
      const saldo = accs[c.clientId]?.saldo ?? 0;
      const diasSinComprar = c.ultimaCompra
        ? Math.floor((now - c.ultimaCompra) / DAY_MS)
        : null;
      const pagosVencidos = c.pendientes.filter((p) => p.falta.includes("pago"));
      const maxDiasDeuda = pagosVencidos.length
        ? Math.max(...pagosVencidos.map((p) => p.dias))
        : 0;
      const flags: string[] = [];
      if (saldo > 0.005) {
        flags.push(
          `debe $${+saldo.toFixed(2)}${maxDiasDeuda ? ` hace ${maxDiasDeuda} día(s)` : ""}`,
        );
      }
      for (const p of c.pendientes) {
        const entregas = p.falta.filter((x) => x.startsWith("entrega"));
        if (entregas.length) {
          flags.push(`factura #${p.factura}: falta ${entregas.join(" y ")} (${p.dias} día(s))`);
        }
      }
      if (diasSinComprar !== null && diasSinComprar > 14) {
        flags.push(`sin comprar hace ${diasSinComprar} día(s)`);
      }
      return {
        entry: {
          clientId: c.clientId,
          cliente: nameById.get(c.clientId) ?? "—",
          saldo: +saldo.toFixed(2),
          facturas: c.facturas,
          dias_sin_comprar: diasSinComprar,
          pendientes: c.pendientes,
          flags,
        },
        urg: saldo * 1000 + maxDiasDeuda,
      };
    })
    .sort((a, b) => b.urg - a.urg)
    .map((x) => x.entry);

  if (clientQuery !== undefined && clientQuery.trim() !== "") {
    const q = clientQuery.trim().toLowerCase();
    const hit =
      out.find((c) => c.cliente.toLowerCase() === q) ??
      out.find((c) => c.cliente.toLowerCase().includes(q));
    return hit ? [hit] : [];
  }
  return out;
}
