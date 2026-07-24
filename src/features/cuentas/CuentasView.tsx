// Pestaña Cuentas corrientes: saldos por cliente/proveedor DERIVADOS por ID
// (domain/accounts.computeAccounts sobre invoices + ledger), detalle de movimientos y
// registro manual de pagos/gastos (insert de UNA fila de ledger). Paridad con
// CuentasView.jsx viejo — sin la fusión de cuentas: el hack de aliases por nombre
// desaparece porque la identidad la da client_id/supplier_id (REBUILD-PLAN).
import { Fragment, useMemo, useState } from "react";
import { useClients } from "../../data/clients";
import { useDeleteLedgerEntry, useInsertLedgerEntry } from "../../data/ledger";
import { useSuppliers } from "../../data/suppliers";
import { computeAccounts, type Side } from "../../domain/accounts";
import { MONTHS_ES } from "../../domain/analytics";
import { dmyToISO, fmtDMY, money, todayDMY } from "../../domain/orders";
import s from "../mesa/styles";
import { useDeskData } from "../shared/useDeskData";

const invTable = {
  borderCollapse: "collapse" as const,
  width: "100%",
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
const invInput = {
  background: "#11151f",
  border: "1px solid #232a3a",
  color: "#e8ecf3",
  padding: "6px 8px",
  borderRadius: 4,
  fontFamily: "inherit",
  fontSize: 12,
  outline: "none",
} as const;
const acctTabs = {
  display: "flex",
  gap: 6,
  flexWrap: "wrap" as const,
  padding: 8,
  background: "#0f131c",
  border: "1px solid #1c2230",
  borderRadius: 6,
  marginBottom: 14,
} as const;
const acctTab = {
  display: "inline-flex",
  gap: 6,
  alignItems: "center",
  background: "#171c28",
  border: "1px solid #232a3a",
  color: "#aeb6c5",
  borderRadius: 5,
  padding: "5px 10px",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12,
} as const;
const acctTabOn = { background: "#1d2740", borderColor: "#3a5b8f", color: "#e8ecf3" } as const;
const acctMonth = {
  background: "#1a2233",
  color: "#8fb0dd",
  fontWeight: 700,
  fontSize: 11,
  letterSpacing: 1,
  padding: "4px 10px",
  textTransform: "uppercase" as const,
} as const;
const chipX = { cursor: "pointer", color: "#8b94a7", fontSize: 14, lineHeight: 1, padding: "0 2px" } as const;
const askHint = { fontSize: 10.5, color: "#525a6b", marginTop: 8 } as const;
const ctrlLabel = { display: "flex", flexDirection: "column" as const, gap: 4 } as const;
const ctrlText = { fontSize: 10, color: "#6b7385", letterSpacing: 1 } as const;

const saldoColor = (saldo: number): string =>
  saldo > 0.005 ? "#fbbf24" : saldo < -0.005 ? "#4ade80" : "#6b7385";

type PayForm = { amount: string; concept: string; date: string; type: "pago" | "gasto" };

export function CuentasView() {
  const desk = useDeskData();
  const clients = useClients();
  const suppliers = useSuppliers();
  const insertLedger = useInsertLedgerEntry();
  const deleteLedger = useDeleteLedgerEntry();

  const [side, setSide] = useState<Side>("client");
  const [selectedId, setSelectedId] = useState("");
  const [payForm, setPayForm] = useState<PayForm>({
    amount: "",
    concept: "",
    date: todayDMY(),
    type: "pago",
  });

  const nameOf = useMemo(() => {
    const clientById = new Map((clients.data ?? []).map((c) => [c.id, c.name]));
    const supplierById = new Map((suppliers.data ?? []).map((sp) => [sp.id, sp.name]));
    return (partyId: string): string => {
      if (partyId === "—") return "—";
      const name = side === "client" ? clientById.get(partyId) : supplierById.get(partyId);
      return name ?? "(cuenta borrada)"; // soft-deleted: el saldo sigue existiendo
    };
  }, [clients.data, suppliers.data, side]);

  const accounts = useMemo(
    () => computeAccounts({ invoices: desk.invoices, ledger: desk.ledger }, side),
    [desk.invoices, desk.ledger, side],
  );
  const accountIds = useMemo(
    () => Object.keys(accounts).sort((a, b) => nameOf(a).localeCompare(nameOf(b))),
    [accounts, nameOf],
  );
  const totalSaldo = useMemo(
    () => Object.values(accounts).reduce((a, x) => a + x.saldo, 0),
    [accounts],
  );
  const currentAccount = accounts[selectedId] ?? null;

  async function registerPay() {
    if (!currentAccount) {
      alert("Elegí una cuenta primero.");
      return;
    }
    const amt = parseFloat(String(payForm.amount).replace(/[^0-9.]/g, "")) || 0;
    if (!amt) {
      alert("Poné un monto.");
      return;
    }
    if (currentAccount.partyId === "—") {
      alert("Esta cuenta agrupa facturas sin cliente asignado; asignales cliente para registrar pagos.");
      return;
    }
    await insertLedger.mutateAsync({
      side,
      party_type: side,
      party_id: currentAccount.partyId,
      type: payForm.type,
      amount: amt,
      concept:
        payForm.concept.trim() || (payForm.type === "pago" ? "Pago" : "Gasto envío proveedor"),
      date: dmyToISO(payForm.date || todayDMY()),
    });
    setPayForm((f) => ({ ...f, amount: "", concept: "" }));
  }

  async function removeEntry(id: string | undefined) {
    if (!id) return;
    if (!confirm("¿Borrar este movimiento manual?")) return;
    await deleteLedger.mutateAsync(id);
  }

  if (desk.loading || clients.isLoading || suppliers.isLoading) {
    return (
      <section style={s.section}>
        <div style={s.sectionTitle}>CUENTAS CORRIENTES</div>
        <div style={askHint}>Cargando cuentas…</div>
      </section>
    );
  }

  return (
    <section style={s.section}>
      <div style={s.sectionTitle}>CUENTAS CORRIENTES</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button
          onClick={() => {
            setSide("client");
            setSelectedId("");
          }}
          style={{ ...s.planTab, ...(side === "client" ? s.planTabOn : {}) }}
        >
          👤 Clientes (nos deben)
        </button>
        <button
          onClick={() => {
            setSide("supplier");
            setSelectedId("");
          }}
          style={{ ...s.planTab, ...(side === "supplier" ? s.planTabOn : {}) }}
        >
          🏭 Proveedores (les debemos)
        </button>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#9aa4b2" }}>
          Total {side === "client" ? "por cobrar" : "por pagar"}:{" "}
          <b style={{ color: totalSaldo >= 0 ? "#fbbf24" : "#4ade80" }}>{money(totalSaldo)}</b>
        </span>
      </div>

      {/* solapas: una por cuenta */}
      <div style={acctTabs}>
        {accountIds.length === 0 && (
          <span style={askHint}>Sin cuentas todavía. Generá una factura o registrá un movimiento.</span>
        )}
        {accountIds.map((id) => {
          const on = selectedId === id;
          const sal = accounts[id]!.saldo;
          return (
            <button key={id} onClick={() => setSelectedId(id)} style={{ ...acctTab, ...(on ? acctTabOn : {}) }}>
              {nameOf(id)} <b style={{ color: saldoColor(sal) }}>{money(sal)}</b>
            </button>
          );
        })}
      </div>

      {!currentAccount ? (
        <div style={askHint}>Elegí una cuenta arriba para ver su detalle.</div>
      ) : (
        <div style={{ border: "1px solid #1c2230", borderRadius: 6, overflow: "hidden" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "10px 12px",
              background: "#131823",
            }}
          >
            <b style={{ color: "#e8ecf3", fontSize: 14 }}>{nameOf(currentAccount.partyId)}</b>
            <span style={{ fontSize: 13 }}>
              {side === "client" ? "Nos debe" : "Le debemos"}:{" "}
              <b style={{ color: saldoColor(currentAccount.saldo) }}>{money(currentAccount.saldo)}</b>
            </span>
          </div>
          <table style={invTable}>
            <thead>
              <tr>
                <th style={{ ...invTh, textAlign: "left" }}>Fecha</th>
                <th style={{ ...invTh, textAlign: "left" }}>Concepto</th>
                <th style={{ ...invTh, textAlign: "left" }}>Ref</th>
                <th style={invTh} title={side === "client" ? "Venta (les damos crédito)" : "Pago que hacemos"}>
                  Débito
                </th>
                <th style={invTh} title={side === "client" ? "Pago que recibimos" : "Compra (nos dan crédito)"}>
                  Crédito
                </th>
                <th style={invTh}>Saldo</th>
                <th style={invTh}></th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                let lastMonth: number | null = null;
                return currentAccount.rows.map((m) => {
                  const d = new Date(m.when);
                  const mk = d.getFullYear() * 12 + d.getMonth();
                  // en cliente: Débito=venta(cargo), Crédito=pago. En proveedor: Débito=pago, Crédito=compra(cargo).
                  const debCol = side === "client" ? m.cargo : m.pago;
                  const credCol = side === "client" ? m.pago : m.cargo;
                  const header =
                    mk !== lastMonth
                      ? ((lastMonth = mk),
                        (
                          <tr key={`mh-${mk}`}>
                            <td colSpan={7} style={acctMonth}>
                              {MONTHS_ES[d.getMonth()]} {d.getFullYear()}
                            </td>
                          </tr>
                        ))
                      : null;
                  return (
                    <Fragment key={m.key}>
                      {header}
                      <tr>
                        <td style={{ ...invTd, textAlign: "left" }}>{fmtDMY(m.when)}</td>
                        <td style={{ ...invTd, textAlign: "left", color: "#cfd6e4" }}>{m.concept}</td>
                        <td style={{ ...invTd, textAlign: "left", color: "#6fa8e6" }}>
                          {m.ref ? `#${m.ref}` : ""}
                        </td>
                        <td style={{ ...invTd, color: "#fbbf24" }}>{debCol ? money(debCol) : ""}</td>
                        <td style={{ ...invTd, color: "#4ade80" }}>{credCol ? money(credCol) : ""}</td>
                        <td
                          style={{
                            ...invTd,
                            background: "#0f1a12",
                            color: m.saldo < -0.005 ? "#f87171" : "#cfe6b8",
                            fontWeight: 600,
                          }}
                        >
                          {money(m.saldo)}
                        </td>
                        <td style={invTd}>
                          {m.derived ? (
                            <span
                              style={{ color: "#3a4255", fontSize: 10 }}
                              title="Derivado de la factura — se edita/borra desde el Historial"
                            >
                              🔒
                            </span>
                          ) : (
                            <span style={chipX} onClick={() => void removeEntry(m.id)}>
                              ×
                            </span>
                          )}
                        </td>
                      </tr>
                    </Fragment>
                  );
                });
              })()}
            </tbody>
          </table>
          {/* registrar pago / gasto en esta cuenta */}
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "flex-end",
              padding: 10,
              borderTop: "1px solid #1c2230",
              background: "#0f131c",
            }}
          >
            <label style={ctrlLabel}>
              <span style={ctrlText}>TIPO</span>
              <select
                value={payForm.type}
                onChange={(e) =>
                  setPayForm((f) => ({ ...f, type: e.target.value === "gasto" ? "gasto" : "pago" }))
                }
                style={{ ...invInput, width: 140 }}
              >
                <option value="pago">Pago (baja el saldo)</option>
                <option value="gasto">Gasto envío (sube el saldo)</option>
              </select>
            </label>
            <label style={ctrlLabel}>
              <span style={ctrlText}>MONTO</span>
              <input
                value={payForm.amount}
                onChange={(e) => setPayForm((f) => ({ ...f, amount: e.target.value }))}
                style={{ ...invInput, width: 100 }}
                inputMode="decimal"
                placeholder="0"
              />
            </label>
            <label style={ctrlLabel}>
              <span style={ctrlText}>FECHA</span>
              <input
                value={payForm.date}
                onChange={(e) => setPayForm((f) => ({ ...f, date: e.target.value }))}
                style={{ ...invInput, width: 110 }}
                placeholder="d/m/aaaa"
              />
            </label>
            <label style={ctrlLabel}>
              <span style={ctrlText}>CONCEPTO</span>
              <input
                value={payForm.concept}
                onChange={(e) => setPayForm((f) => ({ ...f, concept: e.target.value }))}
                style={{ ...invInput, width: 180 }}
                placeholder="opcional"
              />
            </label>
            <button onClick={() => void registerPay()} style={{ ...s.toolBtn, marginLeft: 0 }}>
              + Registrar en {nameOf(currentAccount.partyId)}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
