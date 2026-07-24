// Shell Fase 7: router de tabs (Mesa | Órdenes | Historial | Clientes | Cuentas | PnL |
// Analítica; Mesa default). Errores de datos SIEMPRE visibles (hub central → toast).
// El seed idempotente de departments/categories corre al boot (src/data/departments.ts).
// Cross-tab: "Editar" en Historial abre Órdenes en modo edición; el checkpoint de
// IMEIs del timeline de Órdenes abre el editor de IMEIs en Historial.
import { useEffect, useState } from "react";
import { errorMessage, setDataErrorHandler } from "../data/errors";
import { useEnsureCatalogSeed } from "../data/departments";
import { AgentView } from "../features/agent/AgentView";
import { AnaliticaView } from "../features/analitica/AnaliticaView";
import { ClientesView } from "../features/clientes/ClientesView";
import { CuentasView } from "../features/cuentas/CuentasView";
import { HistorialView } from "../features/historial/HistorialView";
import { MesaView } from "../features/mesa/MesaView";
import { OrdenesView } from "../features/ordenes/OrdenesView";
import { PnLView } from "../features/pnl/PnLView";
import s from "../features/mesa/styles";

type Tab =
  | "mesa"
  | "ordenes"
  | "historial"
  | "clientes"
  | "cuentas"
  | "pnl"
  | "analitica"
  | "agente";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "mesa", label: "Mesa" },
  { id: "ordenes", label: "Órdenes" },
  { id: "historial", label: "Historial" },
  { id: "clientes", label: "Clientes" },
  { id: "cuentas", label: "Cuentas" },
  { id: "pnl", label: "PnL" },
  { id: "analitica", label: "Analítica" },
  { id: "agente", label: "Agente" },
];

export function App() {
  const [toast, setToast] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("mesa");
  const [editInvoiceId, setEditInvoiceId] = useState<string | null>(null);
  const [imeiInvoiceId, setImeiInvoiceId] = useState<string | null>(null);

  useEffect(() => {
    setDataErrorHandler(({ operation, error }) => {
      console.error(`[data] ${operation} falló:`, error);
      setToast(`${operation}: ${errorMessage(error)}`);
    });
    return () => setDataErrorHandler(null);
  }, []);

  useEnsureCatalogSeed();

  return (
    <main style={s.page}>
      <div style={s.header}>
        <h1 style={s.h1}>PRICE DESK</h1>
        <span style={s.sub}>v2 · Fase 8 — Mesa · Órdenes · Historial · Clientes · Cuentas · PnL · Analítica · Agente</span>
        <span style={{ display: "inline-flex", gap: 6, marginLeft: 16 }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{ ...s.planTab, ...(tab === t.id ? s.planTabOn : {}) }}
            >
              {t.label}
            </button>
          ))}
        </span>
      </div>

      {toast && (
        <div
          role="alert"
          style={{
            background: "#2a1117",
            border: "1px solid #7f1d1d",
            color: "#fca5a5",
            borderRadius: 6,
            padding: "8px 12px",
            marginBottom: 12,
            fontSize: 12.5,
          }}
        >
          {toast}
          <button
            onClick={() => setToast(null)}
            style={{
              marginLeft: 12,
              background: "transparent",
              color: "#fca5a5",
              border: "none",
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </div>
      )}

      {tab === "mesa" && <MesaView />}
      {tab === "ordenes" && (
        <OrdenesView
          editInvoiceId={editInvoiceId}
          onDoneEditing={() => {
            setEditInvoiceId(null);
            setTab("historial");
          }}
          onLoadImeis={(invoiceId) => {
            setImeiInvoiceId(invoiceId);
            setTab("historial");
          }}
        />
      )}
      {tab === "historial" && (
        <HistorialView
          onEdit={(invoiceId) => {
            setEditInvoiceId(invoiceId);
            setTab("ordenes");
          }}
          autoImeiInvoiceId={imeiInvoiceId}
          onAutoImeiHandled={() => setImeiInvoiceId(null)}
        />
      )}
      {tab === "clientes" && <ClientesView />}
      {tab === "cuentas" && <CuentasView />}
      {tab === "pnl" && <PnLView />}
      {tab === "analitica" && <AnaliticaView />}
      {tab === "agente" && <AgentView />}
    </main>
  );
}
