// Vista de PRUEBA de la Fase 4 (la Mesa real es Fase 5): valida el stack end-to-end en
// el navegador — lista de models (useQuery), alta canónica con self-alias (mutación),
// errores visibles vía el hub central, y propagación Realtime entre pestañas.
import { useEffect, useState, type FormEvent } from "react";
import { errorMessage, setDataErrorHandler } from "../data/errors";
import { useModels } from "../data/models";
import { useCreateModelWithAlias } from "../data/resolverRepo";

export function App() {
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    // el hub central de errores de datos → toast global (además de la consola)
    setDataErrorHandler(({ operation, error }) => {
      console.error(`[data] ${operation} falló:`, error);
      setToast(`${operation}: ${errorMessage(error)}`);
    });
    return () => setDataErrorHandler(null);
  }, []);

  const models = useModels();
  const createModel = useCreateModelWithAlias();
  const [name, setName] = useState("");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const canonicalName = name.trim();
    if (!canonicalName) return;
    createModel.mutate({ canonicalName }, { onSuccess: () => setName("") });
  };

  return (
    <main style={{ fontFamily: "system-ui", padding: 24, maxWidth: 640 }}>
      <h1>Price Desk v2 — Fase 4</h1>
      <p style={{ color: "#666" }}>
        Vista de prueba de la capa de datos (TanStack Query + Realtime). Abrí dos pestañas:
        el alta en una aparece en la otra sin recargar (requiere 0002_realtime.sql aplicado).
      </p>

      {toast && (
        <div
          role="alert"
          style={{ background: "#fee", border: "1px solid #c00", padding: 8, marginBottom: 12 }}
        >
          {toast}{" "}
          <button onClick={() => setToast(null)} style={{ marginLeft: 8 }}>
            ×
          </button>
        </div>
      )}

      <form onSubmit={onSubmit} style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nombre canónico del modelo (ej: S26 Ultra 12/512)"
          style={{ flex: 1, padding: 6 }}
        />
        <button type="submit" disabled={createModel.isPending}>
          {createModel.isPending ? "Creando…" : "Crear modelo"}
        </button>
      </form>

      {models.isLoading && <p>Cargando modelos…</p>}
      {models.isError && <p style={{ color: "#c00" }}>Error: {errorMessage(models.error)}</p>}
      {models.data && (
        <>
          <p>
            <strong>{models.data.length}</strong> modelos
          </p>
          <ul>
            {models.data.map((m) => (
              <li key={m.id}>
                {m.canonical_name}{" "}
                <code style={{ color: "#999", fontSize: 12 }}>{m.id.slice(0, 8)}</code>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
