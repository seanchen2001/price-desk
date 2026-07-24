// Pestaña PnL / Margen: agregados desde las facturas generadas (ventas) + gastos del
// ledger. Paridad con PnLView.jsx viejo (misma matemática: venta = subtotal ?? total,
// margen = ventas − costo − gastos), con filtro de período agregado (Todo = idéntico al
// viejo, que no filtraba). Nombres resueltos por ID (cliente / proveedor).
import { useMemo, useState } from "react";
import { useClients } from "../../data/clients";
import { useSuppliers } from "../../data/suppliers";
import { parseWhen } from "../../domain/accounts";
import { computePnl, periodStart, type PnlPeriod } from "../../domain/analytics";
import { fmtDMY, money } from "../../domain/orders";
import s from "../mesa/styles";
import { useDeskData } from "../shared/useDeskData";

const invTable = {
  borderCollapse: "collapse" as const,
  width: "100%",
  marginTop: 8,
  border: "1px solid #1c2230",
} as const;
const invTh = {
  background: "#11151f",
  color: "#8b94a7",
  fontSize: 10,
  fontWeight: 600,
  textAlign: "right" as const,
  padding: "6px 8px",
  borderBottom: "1px solid #1c2230",
} as const;
const invTd = {
  padding: "3px 8px",
  textAlign: "right" as const,
  borderBottom: "1px solid #151a26",
  fontVariantNumeric: "tabular-nums" as const,
} as const;
const askHint = { fontSize: 10.5, color: "#525a6b", marginTop: 8 } as const;

const PERIODS: Array<{ id: PnlPeriod; label: string }> = [
  { id: "todo", label: "Todo" },
  { id: "mes", label: "Este mes" },
  { id: "semana", label: "Esta semana" },
];

export function PnLView() {
  const desk = useDeskData();
  const clients = useClients();
  const suppliers = useSuppliers();
  const [period, setPeriod] = useState<PnlPeriod>("todo");

  const clientNameById = useMemo(
    () => new Map((clients.data ?? []).map((c) => [c.id, c.name])),
    [clients.data],
  );
  const supplierNameById = useMemo(
    () => new Map((suppliers.data ?? []).map((sp) => [sp.id, sp.name])),
    [suppliers.data],
  );

  const pnl = useMemo(
    () => computePnl({ invoices: desk.invoices, ledger: desk.ledger }, periodStart(period)),
    [desk.invoices, desk.ledger, period],
  );

  if (desk.loading || clients.isLoading || suppliers.isLoading) {
    return (
      <section style={s.section}>
        <div style={s.sectionTitle}>PnL / MARGEN — desde las facturas generadas (ventas)</div>
        <div style={askHint}>Cargando PnL…</div>
      </section>
    );
  }

  return (
    <section style={s.section}>
      <div style={s.sectionTitle}>PnL / MARGEN — desde las facturas generadas (ventas)</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {PERIODS.map((p) => (
          <button
            key={p.id}
            onClick={() => setPeriod(p.id)}
            style={{ ...s.planTab, ...(period === p.id ? s.planTabOn : {}) }}
          >
            {p.label}
          </button>
        ))}
      </div>
      {pnl.sales.length === 0 ? (
        <div style={askHint}>
          {period === "todo"
            ? "Todavía no hay facturas. Generá una factura en Órdenes y acá ves ventas, costo y margen."
            : "Sin facturas en este período."}
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
            {(
              [
                ["Ventas", money(pnl.ventas), "#fbbf24"],
                ["Costo", money(pnl.costo), "#9aa4b2"],
                ["Gastos envío", money(pnl.gastos), "#9aa4b2"],
                ["Margen", money(pnl.margen), "#4ade80"],
                ["Margen %", pnl.margenPct.toFixed(1) + "%", "#4ade80"],
                ["Piezas", String(pnl.piezas), "#cfd6e4"],
                ["Facturas", String(pnl.sales.length), "#cfd6e4"],
              ] as const
            ).map(([k, v, c]) => (
              <div
                key={k}
                style={{
                  background: "#11151f",
                  border: "1px solid #1c2230",
                  borderRadius: 6,
                  padding: "10px 14px",
                  minWidth: 110,
                }}
              >
                <div style={{ fontSize: 10, color: "#6b7385", letterSpacing: 1 }}>{k.toUpperCase()}</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: c }}>{v}</div>
              </div>
            ))}
          </div>

          <div style={{ ...s.sectionTitle, marginTop: 4 }}>Por factura</div>
          <table style={invTable}>
            <thead>
              <tr>
                <th style={{ ...invTh, textAlign: "left" }}>#</th>
                <th style={{ ...invTh, textAlign: "left" }}>Fecha</th>
                <th style={{ ...invTh, textAlign: "left" }}>Cliente</th>
                <th style={invTh}>Piezas</th>
                <th style={invTh}>Venta</th>
                <th style={invTh}>Costo</th>
                <th style={invTh}>Margen</th>
                <th style={invTh}>%</th>
              </tr>
            </thead>
            <tbody>
              {pnl.sales.map((f) => {
                const venta = Number(f.subtotal ?? f.total) || 0;
                const costo = Number(f.cost) || 0;
                const mg = venta - costo;
                return (
                  <tr key={f.id}>
                    <td style={{ ...invTd, textAlign: "left", color: "#6fa8e6" }}>#{f.no}</td>
                    <td style={{ ...invTd, textAlign: "left" }}>{fmtDMY(parseWhen(f.date, f.ts))}</td>
                    <td style={{ ...invTd, textAlign: "left", color: "#cfd6e4" }}>
                      {f.clientId ? (clientNameById.get(f.clientId) ?? "(cliente borrado)") : "—"}
                    </td>
                    <td style={invTd}>{f.piezas ?? 0}</td>
                    <td style={{ ...invTd, color: "#fbbf24" }}>{money(venta)}</td>
                    <td style={{ ...invTd, color: "#9aa4b2" }}>{money(costo)}</td>
                    <td style={{ ...invTd, color: mg >= 0 ? "#4ade80" : "#f87171" }}>{money(mg)}</td>
                    <td style={{ ...invTd, color: "#9aa4b2" }}>
                      {venta ? ((mg / venta) * 100).toFixed(0) + "%" : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {pnl.supplierRows.length > 0 && (
            <>
              <div style={{ ...s.sectionTitle, marginTop: 16 }}>Costo comprado por proveedor</div>
              <table style={invTable}>
                <thead>
                  <tr>
                    <th style={{ ...invTh, textAlign: "left" }}>Proveedor</th>
                    <th style={invTh}>Costo total</th>
                  </tr>
                </thead>
                <tbody>
                  {pnl.supplierRows.map(({ supplierId, c }) => (
                    <tr key={supplierId}>
                      <td style={{ ...invTd, textAlign: "left", color: "#cfd6e4" }}>
                        {supplierNameById.get(supplierId) ?? "(proveedor borrado)"}
                      </td>
                      <td style={{ ...invTd, color: "#9aa4b2" }}>{money(c)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </section>
  );
}
