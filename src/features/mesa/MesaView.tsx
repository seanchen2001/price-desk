// Mesa de precios (Fase 5) — la vista principal sobre el core nuevo:
// tabs por departamento (tabla `departments`) × categorías DINÁMICAS (tabla `categories`,
// creables/renombrables al vuelo), grilla modelo × proveedor con frescura y agregados,
// paste-&-parse sin IA → resolvedor → cola de confirmación, escalas a price_tiers.
import { useEffect, useState } from "react";
import {
  useCategories,
  useDepartments,
  useInsertCategory,
  useRenameCategory,
  DEFAULT_DEPARTMENT,
} from "../../data/departments";
import { useUpdateModel } from "../../data/models";
import {
  useDeletePrice,
  useDeleteSalePrice,
  useUpsertPrice,
  useUpsertSalePrice,
} from "../../data/prices";
import { ConfirmQueue } from "./ConfirmQueue";
import { MesaTable } from "./MesaTable";
import { PastePanel, type PendingCandidate } from "./PastePanel";
import s from "./styles";
import { useMesaData } from "./useMesaData";

function CategoriesPanel() {
  const categories = useCategories();
  const insertCategory = useInsertCategory();
  const renameCategory = useRenameCategory();
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const create = () => {
    const name = newName.trim();
    if (!name) return;
    insertCategory.mutate(name, { onSuccess: () => setNewName("") });
  };
  const rename = () => {
    if (!renaming || !renaming.name.trim()) return;
    renameCategory.mutate(
      { id: renaming.id, name: renaming.name },
      { onSuccess: () => setRenaming(null) },
    );
  };

  return (
    <section style={s.section}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{ ...s.sectionTitle, cursor: "pointer", marginBottom: open ? 8 : 0 }}
      >
        Categorías ({(categories.data ?? []).length}) — crear / renombrar {open ? "▲" : "▼"}
      </div>
      {open && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {(categories.data ?? []).map((c) =>
            renaming?.id === c.id ? (
              <span key={c.id} style={{ display: "inline-flex", gap: 4 }}>
                <input
                  value={renaming.name}
                  onChange={(e) => setRenaming({ id: c.id, name: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && rename()}
                  style={{ ...s.textInput, width: 140 }}
                />
                <button onClick={rename} style={s.toolBtn} disabled={renameCategory.isPending}>
                  OK
                </button>
                <button onClick={() => setRenaming(null)} style={{ ...s.toolBtn, ...s.toolBtnGhost }}>
                  ×
                </button>
              </span>
            ) : (
              <button
                key={c.id}
                onClick={() => setRenaming({ id: c.id, name: c.name })}
                style={{ ...s.planTab }}
                title="Click para renombrar"
              >
                {c.name} ✎
              </button>
            ),
          )}
          <span style={{ display: "inline-flex", gap: 4 }}>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
              placeholder="+ nueva categoría (ej. Samsung gama alta)"
              style={{ ...s.textInput, width: 240 }}
            />
            {newName.trim() && (
              <button onClick={create} style={s.toolBtn} disabled={insertCategory.isPending}>
                Crear
              </button>
            )}
          </span>
          <span style={s.hint}>
            Mover un modelo de categoría: usá el selector gris al lado del nombre en la tabla.
          </span>
        </div>
      )}
    </section>
  );
}

export function MesaView() {
  const departments = useDepartments();
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(null);
  const [marginPct, setMarginPct] = useState(3);
  const [listaPct, setListaPct] = useState(3);
  const [hideEmpty, setHideEmpty] = useState(false);
  const [queue, setQueue] = useState<PendingCandidate[]>([]);

  // depto inicial: Teléfonos (cuando llega la lista)
  useEffect(() => {
    if (selectedDeptId === null && departments.data && departments.data.length > 0) {
      const def = departments.data.find((d) => d.name === DEFAULT_DEPARTMENT);
      setSelectedDeptId((def ?? departments.data[0])?.id ?? null);
    }
  }, [departments.data, selectedDeptId]);

  const data = useMesaData(selectedDeptId, marginPct, hideEmpty);
  const upsertPrice = useUpsertPrice();
  const deletePrice = useDeletePrice();
  const upsertSale = useUpsertSalePrice();
  const deleteSale = useDeleteSalePrice();
  const updateModel = useUpdateModel();

  const onSetPrice = (modelId: string, supplierId: string, price: number | null) => {
    if (price === null) deletePrice.mutate({ model_id: modelId, supplier_id: supplierId });
    else upsertPrice.mutate({ model_id: modelId, supplier_id: supplierId, price });
  };
  const onSetLista = (modelId: string, price: number | null) => {
    if (price === null) deleteSale.mutate(modelId);
    else upsertSale.mutate({ model_id: modelId, price, manual: true });
  };
  const onSetCategory = (modelId: string, categoryId: string | null) => {
    updateModel.mutate({ id: modelId, patch: { category_id: categoryId } });
  };

  // "Pegar en Lista": congela Mín + listaPct% como Lista manual en todas las filas con precio
  const fillLista = () => {
    for (const g of data.groups) {
      for (const v of g.rows) {
        for (const r of [v.row, ...v.collapsed]) {
          if (r.agg.min !== null) {
            upsertSale.mutate({
              model_id: r.model.id,
              price: Math.round(r.agg.min * (1 + listaPct / 100)),
              manual: true,
            });
          }
        }
      }
    }
  };

  const totalRows = data.groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <div>
      {/* tabs por departamento */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        {data.departments.map((d) => (
          <button
            key={d.id}
            onClick={() => setSelectedDeptId(d.id)}
            style={{ ...s.planTab, ...(selectedDeptId === d.id ? s.planTabOn : {}) }}
          >
            {d.name}
          </button>
        ))}
      </div>

      {/* toolbar */}
      <div style={s.toolbar}>
        <button style={{ ...s.toolBtn, ...s.toolBtnDisabled }} disabled title="Fase posterior">
          Save snapshot (Fase posterior)
        </button>
        <button style={{ ...s.toolBtn, ...s.toolBtnDisabled }} disabled title="Fase posterior">
          Cotización WhatsApp (Fase posterior)
        </button>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}>
          Client +
          <input
            type="number"
            value={marginPct}
            onChange={(e) => setMarginPct(Number(e.target.value) || 0)}
            step="0.5"
            style={s.numInput}
          />
          %
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}>
          Lista = Mín +
          <input
            type="number"
            value={listaPct}
            onChange={(e) => setListaPct(Number(e.target.value) || 0)}
            step="0.5"
            style={s.numInput}
          />
          %
          <button
            onClick={fillLista}
            style={s.toolBtn}
            title="Congela Mín + este % como Lista manual en todas las filas con precio"
          >
            Pegar en Lista
          </button>
        </span>
        <label style={{ ...s.hideToggle, marginLeft: "auto" }}>
          <input
            type="checkbox"
            checked={hideEmpty}
            onChange={(e) => setHideEmpty(e.target.checked)}
            style={s.chk}
          />
          Ocultar sin precio {hideEmpty && data.emptyCount > 0 && `(${data.emptyCount})`}
        </label>
        <span style={s.toolNote}>los precios expiran cada lunes</span>
      </div>

      <PastePanel onQueue={(items) => setQueue((q) => [...q, ...items])} />
      <ConfirmQueue
        items={queue}
        defaultDepartmentId={selectedDeptId}
        onDone={(aliasKey) => setQueue((q) => q.filter((i) => i.aliasKey !== aliasKey))}
      />
      <CategoriesPanel />

      <section style={s.section}>
        {data.loading ? (
          <div style={s.hint}>Cargando la Mesa…</div>
        ) : totalRows === 0 ? (
          <div style={s.hint}>
            No hay modelos en este departamento todavía. Pegá una lista arriba: los que no
            existan van a la cola de confirmación y ahí los creás con su departamento y
            categoría.
          </div>
        ) : (
          <MesaTable
            groups={data.groups}
            deptSuppliers={data.deptSuppliers}
            categories={data.categories}
            marginPct={marginPct}
            onSetPrice={onSetPrice}
            onSetLista={onSetLista}
            onSetCategory={onSetCategory}
          />
        )}
      </section>
    </div>
  );
}
