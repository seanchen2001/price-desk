// Shell Fase 5: la Mesa de precios sobre el core nuevo. Errores de datos SIEMPRE
// visibles (hub central → toast). El seed idempotente de departments/categories corre
// al boot (ver src/data/departments.ts — decisión: upsert al boot, no migración de datos).
import { useEffect, useState } from "react";
import { errorMessage, setDataErrorHandler } from "../data/errors";
import { useEnsureCatalogSeed } from "../data/departments";
import { MesaView } from "../features/mesa/MesaView";
import s from "../features/mesa/styles";

export function App() {
  const [toast, setToast] = useState<string | null>(null);
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
        <span style={s.sub}>v2 · Fase 5 — Mesa de precios</span>
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

      <MesaView />
    </main>
  );
}
