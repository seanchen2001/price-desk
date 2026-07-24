// Cola de confirmación: lo genuinamente nuevo que dejó el paste. Para cada candidato el
// humano decide: (a) ES un modelo existente → confirmCandidate escribe el alias y el
// match queda determinístico para siempre; o (b) crear modelo nuevo (createModelWithAlias
// con departamento/categoría). En ambos casos recién ahí se aplican los precios
// pendientes de ese rawName, por model_id. NUNCA se auto-crea nada.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useCategories, useDepartments } from "../../data/departments";
import { keys } from "../../data/keys";
import { useModels } from "../../data/models";
import { confirmCandidate, createModelWithAlias } from "../../data/resolverRepo";
import { normalize } from "../../domain/normalize";
import { applyEntry } from "./applyQuote";
import { money } from "./MesaTable";
import type { PendingCandidate } from "./PastePanel";
import s from "./styles";

function useResolveCandidate() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["mesa", "resolve-candidate"],
    mutationFn: async (
      vars:
        | { kind: "link"; item: PendingCandidate; modelId: string }
        | {
            kind: "create";
            item: PendingCandidate;
            canonicalName: string;
            departmentId: string | null;
            categoryId: string | null;
          },
    ) => {
      if (vars.kind === "link") {
        await confirmCandidate(vars.item.entry.rawName, vars.modelId);
        await applyEntry(vars.modelId, vars.item.supplierId, vars.item.entry);
        return;
      }
      const model = await createModelWithAlias(vars.canonicalName, {
        ...(vars.categoryId !== null ? { category_id: vars.categoryId } : {}),
        ...(vars.departmentId !== null ? { department_id: vars.departmentId } : {}),
      });
      // si el texto visto normaliza distinto que el canónico, aprender TAMBIÉN esa variante
      if (normalize(vars.item.entry.rawName) !== normalize(vars.canonicalName)) {
        await confirmCandidate(vars.item.entry.rawName, model.id);
      }
      await applyEntry(model.id, vars.item.supplierId, vars.item.entry);
    },
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.models }),
        qc.invalidateQueries({ queryKey: keys.aliases() }),
        qc.invalidateQueries({ queryKey: keys.prices() }),
        qc.invalidateQueries({ queryKey: keys.priceTiers() }),
        qc.invalidateQueries({ queryKey: keys.priceHistory() }),
      ]),
  });
}

function QueueItem(props: {
  item: PendingCandidate;
  defaultDepartmentId: string | null;
  onDone: () => void;
}) {
  const { item, onDone } = props;
  const models = useModels();
  const departments = useDepartments();
  const categories = useCategories();
  const resolve = useResolveCandidate();

  const [mode, setMode] = useState<"link" | "create">("link");
  const [search, setSearch] = useState("");
  const [modelId, setModelId] = useState("");
  const [name, setName] = useState(item.entry.rawName);
  const [deptId, setDeptId] = useState<string>(props.defaultDepartmentId ?? "");
  const [catId, setCatId] = useState<string>("");

  const options = useMemo(() => {
    const all = models.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all.slice(0, 30);
    return all.filter((m) => m.canonical_name.toLowerCase().includes(q)).slice(0, 30);
  }, [models.data, search]);

  const tiersNote =
    item.entry.tiers.length > 1
      ? " · escala: " + item.entry.tiers.map((t) => `${t.min_qty}+→$${t.price}`).join(" ")
      : "";

  const submit = () => {
    if (mode === "link") {
      if (!modelId) return;
      resolve.mutate({ kind: "link", item, modelId }, { onSuccess: onDone });
    } else {
      const canonicalName = name.trim();
      if (!canonicalName) return;
      resolve.mutate(
        {
          kind: "create",
          item,
          canonicalName,
          departmentId: deptId === "" ? null : deptId,
          categoryId: catId === "" ? null : catId,
        },
        { onSuccess: onDone },
      );
    }
  };

  return (
    <div style={s.queueItem}>
      <div style={s.queueName}>{item.entry.rawName}</div>
      <div style={s.queueMeta}>
        {money(item.entry.price)} · {item.supplierName}
        {tiersNote} · visto en: {item.entry.lines.join(" | ")}
      </div>
      <div style={s.queueRow}>
        <button
          onClick={() => setMode("link")}
          style={{ ...s.planTab, ...(mode === "link" ? s.planTabOn : {}) }}
        >
          Es un modelo existente
        </button>
        <button
          onClick={() => setMode("create")}
          style={{ ...s.planTab, ...(mode === "create" ? s.planTabOn : {}) }}
        >
          Crear modelo nuevo
        </button>
        <button onClick={onDone} style={{ ...s.toolBtn, ...s.toolBtnGhost }}>
          Descartar
        </button>
      </div>

      {mode === "link" ? (
        <div style={s.queueRow}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="buscar modelo…"
            style={{ ...s.textInput, width: 180 }}
          />
          <select value={modelId} onChange={(e) => setModelId(e.target.value)} style={s.select}>
            <option value="">— elegir modelo ({options.length}) —</option>
            {options.map((m) => (
              <option key={m.id} value={m.id}>
                {m.canonical_name}
              </option>
            ))}
          </select>
          <button
            onClick={submit}
            disabled={!modelId || resolve.isPending}
            style={{ ...s.primaryBtn, ...(resolve.isPending ? s.busy : {}) }}
          >
            Vincular y aplicar precio
          </button>
        </div>
      ) : (
        <div style={s.queueRow}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ ...s.textInput, width: 240 }}
            title="Nombre canónico del modelo nuevo"
          />
          <select value={deptId} onChange={(e) => setDeptId(e.target.value)} style={s.select}>
            <option value="">— departamento —</option>
            {(departments.data ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <select value={catId} onChange={(e) => setCatId(e.target.value)} style={s.select}>
            <option value="">— categoría —</option>
            {(categories.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            onClick={submit}
            disabled={!name.trim() || resolve.isPending}
            style={{ ...s.primaryBtn, ...(resolve.isPending ? s.busy : {}) }}
          >
            Crear y aplicar precio
          </button>
        </div>
      )}
    </div>
  );
}

export function ConfirmQueue(props: {
  items: PendingCandidate[];
  defaultDepartmentId: string | null;
  onDone: (aliasKey: string) => void;
}) {
  if (props.items.length === 0) return null;
  return (
    <section style={{ ...s.section, borderColor: "#3b2a10" }}>
      <div style={{ ...s.sectionTitle, color: "#fbbf24" }}>
        Cola de confirmación — {props.items.length} modelo(s) nuevo(s) del paste (nada se
        auto-crea)
      </div>
      {props.items.map((item) => (
        <QueueItem
          key={item.aliasKey + item.supplierId}
          item={item}
          defaultDepartmentId={props.defaultDepartmentId}
          onDone={() => props.onDone(item.aliasKey)}
        />
      ))}
    </section>
  );
}
