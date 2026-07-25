// Shell v2 con la CÁSCARA VISUAL del desk viejo (electronics-price-tool.jsx):
// header con título/subtítulo + badge ÚLTIMO LUNES a la derecha, viewNav con las
// pestañas grandes con emoji (mismo orden viejo: Mesa · Órdenes · Clientes · Cuentas ·
// PnL · [Analítica] · Historial), y el chat del agente FIJO a la derecha como el
// ChatBox viejo (el contenido se corre con padding-right, transición incluida).
// Errores de datos SIEMPRE visibles (hub central → toast).
// Cross-tab: "Editar" en Historial abre Órdenes en modo edición; el checkpoint de
// IMEIs del timeline de Órdenes abre el editor de IMEIs en Historial.
import { useEffect, useState } from "react";
import { errorMessage, setDataErrorHandler } from "../data/errors";
import { useEnsureCatalogSeed } from "../data/departments";
import { mondayStart } from "../domain/pricing";
import { AgentPanel } from "../features/agent/AgentView";
import { useAgentPanel } from "../features/agent/store";
import { AnaliticaView } from "../features/analitica/AnaliticaView";
import { ClientesView } from "../features/clientes/ClientesView";
import { CuentasView } from "../features/cuentas/CuentasView";
import { HistorialView } from "../features/historial/HistorialView";
import { MesaView } from "../features/mesa/MesaView";
import { OrdenesView } from "../features/ordenes/OrdenesView";
import { PnLView } from "../features/pnl/PnLView";
import s from "../features/mesa/styles";

type Tab = "mesa" | "ordenes" | "clientes" | "cuentas" | "pnl" | "analitica" | "historial";

// orden y rótulos del viewNav viejo (Analítica estaba oculta en el viejo; acá va antes
// de Historial). El emoji + texto es parte de la identidad visual del desk.
const TABS: Array<{ id: Tab; label: string; short: string }> = [
  { id: "mesa", label: "📊 Mesa de precios", short: "Mesa" },
  { id: "ordenes", label: "🧾 Órdenes · factura / remito", short: "Órdenes" },
  { id: "clientes", label: "👤 Clientes", short: "Clientes" },
  { id: "cuentas", label: "💰 Cuentas", short: "Cuentas" },
  { id: "pnl", label: "📈 PnL", short: "PnL" },
  { id: "analitica", label: "🧮 Analítica", short: "Analítica" },
  { id: "historial", label: "📜 Historial", short: "Historial" },
];

const fmtDMY = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
};

export function App() {
  const [toast, setToast] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("mesa");
  const [editInvoiceId, setEditInvoiceId] = useState<string | null>(null);
  const [imeiInvoiceId, setImeiInvoiceId] = useState<string | null>(null);
  const chatOpen = useAgentPanel((st) => st.open);

  useEffect(() => {
    setDataErrorHandler(({ operation, error }) => {
      console.error(`[data] ${operation} falló:`, error);
      setToast(`${operation}: ${errorMessage(error)}`);
    });
    return () => setDataErrorHandler(null);
  }, []);

  useEnsureCatalogSeed();

  return (
    <main style={{ ...s.page, paddingRight: chatOpen ? 360 + 16 : 20 }}>
      <header style={s.header}>
        <div>
          <div style={s.h1}>PRICE DESK</div>
          <div style={s.sub}>supplier comparison · adjustable margin · v2</div>
        </div>
        <div style={s.controls}>
          <div style={s.mondayBadge}>
            <span style={s.ctrlText}>ÚLTIMO LUNES</span>
            <span style={s.mondayDate}>{fmtDMY(mondayStart())}</span>
          </div>
        </div>
      </header>

      <div style={s.viewNav}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{ ...s.viewTab, ...(tab === t.id ? s.viewTabOn : {}) }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {toast && (
        <div role="alert" style={{ ...s.errorMsg, marginBottom: 12, fontSize: 12.5 }}>
          {toast}
          <button
            onClick={() => setToast(null)}
            style={{
              marginLeft: 12,
              background: "transparent",
              color: "#f87171",
              border: "none",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            ×
          </button>
        </div>
      )}

      <div style={s.mesaMain}>
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
      </div>

      <AgentPanel activeTabLabel={TABS.find((t) => t.id === tab)?.short ?? tab} />
    </main>
  );
}
