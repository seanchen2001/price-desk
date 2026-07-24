// Pestaña Analítica: agregados derivados del Historial — margen por mes (barras), top
// clientes, top proveedores, top modelos, inventario derivado y alertas de arbitraje.
// Portado de AnaliticaView.jsx + lib/analytics.js/inventory.js/arbitrage.js al stack
// nuevo, por ID (la vista resuelve los nombres). En el viejo estaba oculta tras
// {false&&}; acá queda EXPUESTA como tab. No usa storage propio: todo se calcula al vuelo.
import { useMemo, type ReactNode } from "react";
import { useClients } from "../../data/clients";
import { useModels } from "../../data/models";
import { usePrices, useSalePrices } from "../../data/prices";
import { useSuppliers } from "../../data/suppliers";
import { analyticsData } from "../../domain/analytics";
import { arbitrageScan, type ArbitrageInputRow } from "../../domain/arbitrage";
import { computeInventory } from "../../domain/inventory";
import { money } from "../../domain/orders";
import s from "../mesa/styles";
import { useDeskData } from "../shared/useDeskData";

const card = {
  background: "#11151f",
  border: "1px solid #1c2230",
  borderRadius: 6,
  padding: 12,
  flex: "1 1 280px",
  minWidth: 260,
} as const;
const invTable = {
  borderCollapse: "collapse" as const,
  width: "100%",
  marginTop: 6,
  border: "1px solid #1c2230",
} as const;
const invTd = {
  padding: "3px 8px",
  textAlign: "right" as const,
  borderBottom: "1px solid #151a26",
  fontVariantNumeric: "tabular-nums" as const,
} as const;
const askHint = { fontSize: 10.5, color: "#525a6b", marginTop: 8 } as const;

export function AnaliticaView() {
  const desk = useDeskData();
  const clients = useClients();
  const suppliers = useSuppliers();
  const models = useModels();
  const salePrices = useSalePrices();
  const prices = usePrices();

  const loading =
    desk.loading ||
    clients.isLoading ||
    suppliers.isLoading ||
    models.isLoading ||
    salePrices.isLoading ||
    prices.isLoading;

  const clientName = useMemo(() => {
    const m = new Map((clients.data ?? []).map((c) => [c.id, c.name]));
    return (id: string) => (id === "—" ? "—" : (m.get(id) ?? "(cliente borrado)"));
  }, [clients.data]);
  const supplierName = useMemo(() => {
    const m = new Map((suppliers.data ?? []).map((sp) => [sp.id, sp.name]));
    return (id: string) => m.get(id) ?? "(proveedor borrado)";
  }, [suppliers.data]);
  const modelName = useMemo(() => {
    const m = new Map((models.data ?? []).map((x) => [x.id, x.canonical_name]));
    return (id: string) => (id === "—" ? "—" : (m.get(id) ?? "(modelo borrado)"));
  }, [models.data]);

  const data = useMemo(() => analyticsData({ invoices: desk.invoices }), [desk.invoices]);

  // inventario derivado (compras a cuentas nuestras − ventas); solo modelos con movimiento
  const inventory = useMemo(() => {
    const ownClientIds = new Set((clients.data ?? []).filter((c) => c.es_nuestra).map((c) => c.id));
    return computeInventory({ invoices: desk.invoices, ownClientIds });
  }, [desk.invoices, clients.data]);
  const invRows = useMemo(
    () =>
      Object.values(inventory)
        .filter((r) => r.entradas > 0 || r.onHand !== 0)
        .sort((a, b) => b.onHand - a.onHand),
    [inventory],
  );
  const listaByModel = useMemo(
    () => new Map((salePrices.data ?? []).map((r) => [r.model_id, r.price])),
    [salePrices.data],
  );

  // alertas de arbitraje sobre los precios ACTUALES de la Mesa
  const arbitrage = useMemo(() => {
    const byModel = new Map<string, ArbitrageInputRow>();
    for (const p of prices.data ?? []) {
      const row = byModel.get(p.model_id) ?? { modelId: p.model_id, prices: [] };
      (row.prices as Array<{ supplierId: string; price: number; ts: number | null }>).push({
        supplierId: p.supplier_id,
        price: p.price,
        ts: Date.parse(p.updated_at),
      });
      byModel.set(p.model_id, row);
    }
    return arbitrageScan([...byModel.values()]);
  }, [prices.data]);

  if (loading) {
    return (
      <section style={s.section}>
        <div style={s.sectionTitle}>ANALÍTICA — derivada del Historial (solo facturas)</div>
        <div style={askHint}>Cargando analítica…</div>
      </section>
    );
  }

  const maxV = Math.max(...data.monthly.map((m) => m.ventas), 1);
  const rank = <T,>(rows: readonly T[], render: (row: T, i: number) => ReactNode) => (
    <table style={invTable}>
      <tbody>{rows.map(render)}</tbody>
    </table>
  );

  return (
    <section style={s.section}>
      <div style={s.sectionTitle}>ANALÍTICA — derivada del Historial (solo facturas)</div>
      {data.facturas === 0 ? (
        <div style={askHint}>Todavía no hay facturas. Generá facturas en Órdenes y acá aparecen las tendencias.</div>
      ) : (
        <>
          {/* KPIs */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
            {(
              [
                ["Ventas", money(data.ventas), "#fbbf24"],
                ["Costo", money(data.costo), "#9aa4b2"],
                ["Margen", money(data.margen), "#4ade80"],
                ["Margen % prom.", data.margenPct.toFixed(1) + "%", "#4ade80"],
                ["Piezas", String(data.piezas), "#cfd6e4"],
                ["Facturas", String(data.facturas), "#cfd6e4"],
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

          {/* margen por mes (barras simples) */}
          <div style={{ ...card, marginBottom: 14 }}>
            <div style={s.sectionTitle}>VENTAS / MARGEN POR MES (últimos {data.monthly.length})</div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 12, padding: "6px 4px 0" }}>
              {data.monthly.map((m) => (
                <div key={m.mk} style={{ flex: 1, textAlign: "center", minWidth: 54 }}>
                  <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 4, height: 110 }}>
                    <div
                      title={`Ventas ${money(m.ventas)}`}
                      style={{
                        width: 20,
                        height: `${(m.ventas / maxV) * 100}%`,
                        minHeight: 2,
                        background: "#b98a1e",
                        borderRadius: "3px 3px 0 0",
                      }}
                    />
                    <div
                      title={`Margen ${money(m.margen)}`}
                      style={{
                        width: 20,
                        height: `${(Math.max(m.margen, 0) / maxV) * 100}%`,
                        minHeight: 2,
                        background: "#2f9e57",
                        borderRadius: "3px 3px 0 0",
                      }}
                    />
                  </div>
                  <div style={{ fontSize: 10.5, color: "#8b94a7", marginTop: 6 }}>{m.label}</div>
                  <div style={{ fontSize: 10.5, color: "#fbbf24" }} title="Ventas del mes">
                    {money(Math.round(m.ventas))}
                  </div>
                  <div style={{ fontSize: 10.5, color: m.margen >= 0 ? "#4ade80" : "#f87171" }} title="Margen del mes">
                    {money(Math.round(m.margen))}
                  </div>
                  <div style={{ fontSize: 10, color: "#6b7385" }}>
                    {m.piezas} pzs · {m.facturas} fact.
                  </div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 10, color: "#6b7385", marginTop: 8 }}>
              <span
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  background: "#b98a1e",
                  borderRadius: 2,
                  marginRight: 4,
                  verticalAlign: "-1px",
                }}
              />{" "}
              ventas
              <span
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  background: "#2f9e57",
                  borderRadius: 2,
                  margin: "0 4px 0 12px",
                  verticalAlign: "-1px",
                }}
              />{" "}
              margen (venta − costo)
            </div>
          </div>

          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            <div style={card}>
              <div style={s.sectionTitle}>TOP CLIENTES POR FACTURACIÓN</div>
              {rank(data.topClientes.slice(0, 8), (c, i) => (
                <tr key={c.clientId}>
                  <td style={{ ...invTd, textAlign: "left", color: "#6b7385", width: 22 }}>{i + 1}</td>
                  <td style={{ ...invTd, textAlign: "left", color: "#cfd6e4" }}>{clientName(c.clientId)}</td>
                  <td style={{ ...invTd, color: "#fbbf24" }}>{money(c.ventas)}</td>
                  <td style={{ ...invTd, color: "#6b7385" }}>{c.facturas} fact.</td>
                </tr>
              ))}
            </div>
            <div style={card}>
              <div style={s.sectionTitle}>TOP CLIENTES POR MARGEN</div>
              {rank(data.topClientesPorMargen.slice(0, 8), (c, i) => (
                <tr key={c.clientId}>
                  <td style={{ ...invTd, textAlign: "left", color: "#6b7385", width: 22 }}>{i + 1}</td>
                  <td style={{ ...invTd, textAlign: "left", color: "#cfd6e4" }}>{clientName(c.clientId)}</td>
                  <td style={{ ...invTd, color: c.margen >= 0 ? "#4ade80" : "#f87171" }}>{money(c.margen)}</td>
                  <td style={{ ...invTd, color: "#6b7385" }}>
                    {c.ventas ? ((c.margen / c.ventas) * 100).toFixed(1) + "%" : "—"}
                  </td>
                </tr>
              ))}
            </div>
            <div style={card}>
              <div style={s.sectionTitle}>TOP PROVEEDORES POR COMPRA</div>
              {rank(data.topProveedores.slice(0, 8), (p, i) => (
                <tr key={p.supplierId}>
                  <td style={{ ...invTd, textAlign: "left", color: "#6b7385", width: 22 }}>{i + 1}</td>
                  <td style={{ ...invTd, textAlign: "left", color: "#cfd6e4" }}>{supplierName(p.supplierId)}</td>
                  <td style={{ ...invTd, color: "#9aa4b2" }}>{money(p.compra)}</td>
                </tr>
              ))}
            </div>
            {invRows.length > 0 && (
              <div style={card}>
                <div style={s.sectionTitle}>INVENTARIO — stock y costo promedio real</div>
                <table style={invTable}>
                  <thead>
                    <tr>
                      <th style={{ ...invTd, textAlign: "left", color: "#6b7385" }}>Modelo</th>
                      <th style={{ ...invTd, color: "#6b7385" }}>Stock</th>
                      <th style={{ ...invTd, color: "#6b7385" }}>Costo prom.</th>
                      <th style={{ ...invTd, color: "#6b7385" }}>Lista</th>
                      <th style={{ ...invTd, color: "#6b7385" }}>Margen real</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invRows.slice(0, 12).map((r) => {
                      const lp = listaByModel.get(r.modelId);
                      const mReal = r.avgCost != null && lp != null ? lp - r.avgCost : null;
                      return (
                        <tr key={r.modelId}>
                          <td style={{ ...invTd, textAlign: "left", color: "#cfd6e4" }}>{modelName(r.modelId)}</td>
                          <td style={{ ...invTd, color: r.onHand < 0 ? "#f87171" : "#cfd6e4" }}>{r.onHand}</td>
                          <td style={{ ...invTd, color: "#9aa4b2" }}>{r.avgCost != null ? money(r.avgCost) : "—"}</td>
                          <td style={{ ...invTd, color: "#fbbf24" }}>{lp != null ? money(lp) : "—"}</td>
                          <td
                            style={{
                              ...invTd,
                              color: mReal == null ? "#6b7385" : mReal >= 0 ? "#4ade80" : "#f87171",
                            }}
                          >
                            {mReal != null ? money(mReal) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ fontSize: 10, color: "#6b7385", marginTop: 6 }}>
                  stock = compras a cuentas nuestras − ventas · costo prom. ponderado de las entradas · margen real =
                  lista − costo prom.
                </div>
              </div>
            )}
            <div style={card}>
              <div style={s.sectionTitle}>TOP MODELOS POR VOLUMEN</div>
              {rank(data.topModelos.slice(0, 8), (m, i) => (
                <tr key={m.modelId}>
                  <td style={{ ...invTd, textAlign: "left", color: "#6b7385", width: 22 }}>{i + 1}</td>
                  <td style={{ ...invTd, textAlign: "left", color: "#cfd6e4" }}>{modelName(m.modelId)}</td>
                  <td style={{ ...invTd, color: "#cfd6e4" }}>{m.piezas} pzs</td>
                  <td style={{ ...invTd, color: m.margen >= 0 ? "#4ade80" : "#f87171" }}>{money(m.margen)}</td>
                </tr>
              ))}
            </div>
          </div>
        </>
      )}

      {/* alertas de arbitraje — sobre los precios actuales de la Mesa (lib/arbitrage.js) */}
      <div style={{ ...card, marginTop: 14 }}>
        <div style={s.sectionTitle}>ALERTAS DE ARBITRAJE — proveedor muy por debajo de la mediana</div>
        {arbitrage.length === 0 ? (
          <div style={askHint}>
            Sin arbitrajes detectados: ningún proveedor está ≥3% debajo de la mediana (o falta un segundo precio para
            comparar).
          </div>
        ) : (
          <table style={invTable}>
            <thead>
              <tr>
                <th style={{ ...invTd, textAlign: "left", color: "#6b7385" }}>Modelo</th>
                <th style={{ ...invTd, textAlign: "left", color: "#6b7385" }}>Proveedor</th>
                <th style={{ ...invTd, color: "#6b7385" }}>Precio</th>
                <th style={{ ...invTd, color: "#6b7385" }}>Mediana</th>
                <th style={{ ...invTd, color: "#6b7385" }}>Gap</th>
                <th style={{ ...invTd, textAlign: "left", color: "#6b7385" }}>Nota</th>
              </tr>
            </thead>
            <tbody>
              {arbitrage.slice(0, 10).map((a) => (
                <tr key={`${a.modelId}-${a.lowSupplierId}`}>
                  <td style={{ ...invTd, textAlign: "left", color: "#cfd6e4" }}>{modelName(a.modelId)}</td>
                  <td style={{ ...invTd, textAlign: "left", color: "#cfd6e4" }}>{supplierName(a.lowSupplierId)}</td>
                  <td style={{ ...invTd, color: "#4ade80" }}>{money(a.lowPrice)}</td>
                  <td style={{ ...invTd, color: "#9aa4b2" }}>{money(a.median)}</td>
                  <td style={{ ...invTd, color: a.stale ? "#fbbf24" : "#4ade80" }}>{a.gapPct}%</td>
                  <td style={{ ...invTd, textAlign: "left", color: a.stale ? "#fbbf24" : "#8ee0a8" }}>{a.nota}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
