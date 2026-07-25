// La grilla de la Mesa: modelo × proveedor con edición inline, coloreo por frescura
// (recién/actualizado/expirado + mejor precio + outlier), Mín/Medio/Lista/Cliente.
// Paridad visual con el MesaView viejo (misma información y semántica de color).
import { useState, type CSSProperties, type JSX, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { CategoryRow } from "../../data/departments";
import type { SupplierRow } from "../../data/suppliers";
import s from "./styles";
import { useMesaUi } from "./uiStore";
import type { MesaCategoryGroup, MesaVisualRow } from "./useMesaData";

// anchos default por columna (px) — ajustables con drag en el borde del header,
// persistidos por columna en localStorage (uiStore)
const DEFAULT_W: Record<string, number> = { sku: 250, min: 80, med: 95, lista: 90, client: 100 };
const SUPPLIER_W = 112;

/** th con manija de resize en el borde derecho (drag → ancho persistido). */
function ResizableTh(props: {
  colKey: string;
  defaultW: number;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const width = useMesaUi((st) => st.colWidths[props.colKey]) ?? props.defaultW;
  const setColWidth = useMesaUi((st) => st.setColWidth);
  const onDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: globalThis.MouseEvent) =>
      setColWidth(props.colKey, startW + (ev.clientX - startX));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  // OJO: s.th ya es sticky (top 0, como el viejo) — el grip absoluto se ancla al th sticky.
  return (
    <th style={{ ...s.th, ...props.style, width }}>
      {props.children}
      <span
        onMouseDown={onDown}
        title="Arrastrá para ajustar el ancho"
        style={{
          position: "absolute",
          right: -3,
          top: 0,
          bottom: 0,
          width: 7,
          cursor: "col-resize",
          userSelect: "none",
          zIndex: 2,
        }}
      />
    </th>
  );
}

export const money = (n: number | null | undefined): string =>
  typeof n === "number" ? "$" + Math.round(n).toLocaleString("en-US") : "—";

/** Input no controlado mientras se edita; commit en blur/Enter. Vacío = borrar. */
function EditableNumber(props: {
  value: number | null;
  onCommit: (value: number | null) => void;
  style: CSSProperties;
  title?: string | undefined;
  placeholder?: string;
}) {
  const { value, onCommit, style, title, placeholder } = props;
  const [draft, setDraft] = useState<string | null>(null); // null = no está editando
  const shown = draft ?? (value === null ? "" : String(value));
  const commit = () => {
    if (draft === null) return;
    const cleaned = draft.replace(/[^0-9.,]/g, "").replace(",", ".");
    const n = cleaned === "" ? null : Number(cleaned);
    setDraft(null);
    if (n !== null && !Number.isFinite(n)) return;
    if (n === value) return;
    onCommit(n);
  };
  return (
    <input
      value={shown}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setDraft(shown)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setDraft(null);
      }}
      style={style}
      title={title}
      placeholder={placeholder}
      inputMode="decimal"
    />
  );
}

export function MesaTable(props: {
  groups: MesaCategoryGroup[];
  deptSuppliers: SupplierRow[];
  categories: CategoryRow[];
  marginPct: number;
  onSetPrice: (modelId: string, supplierId: string, price: number | null) => void;
  onSetLista: (modelId: string, price: number | null) => void;
  onSetCategory: (modelId: string, categoryId: string | null) => void;
  /** selección para la cotización WhatsApp (checkbox por fila / por categoría) */
  selectedIds: ReadonlySet<string>;
  onToggleRows: (modelIds: readonly string[], on: boolean) => void;
}) {
  const {
    groups,
    deptSuppliers,
    categories,
    marginPct,
    onSetPrice,
    onSetLista,
    onSetCategory,
    selectedIds,
    onToggleRows,
  } = props;
  const colSpanAll = deptSuppliers.length + 5;
  const colWidths = useMesaUi((st) => st.colWidths);
  const wOf = (key: string, def: number) => colWidths[key] ?? def;
  const tableWidth =
    wOf("sku", DEFAULT_W["sku"]!) +
    deptSuppliers.reduce((n, sp) => n + wOf(`sp:${sp.id}`, SUPPLIER_W), 0) +
    wOf("min", DEFAULT_W["min"]!) +
    wOf("med", DEFAULT_W["med"]!) +
    wOf("lista", DEFAULT_W["lista"]!) +
    wOf("client", DEFAULT_W["client"]!);

  const renderRow = (v: MesaVisualRow) => {
    const row = v.row;
    const { model, agg } = row;
    const spread = agg.min !== null && agg.med !== null && agg.min !== agg.med;
    const delta = spread && agg.min !== null && agg.med !== null ? agg.med - agg.min : 0;
    const listaAuto = agg.min !== null ? Math.round(agg.min * (1 + marginPct / 100)) : null;
    return (
      <tr key={model.id}>
        <td style={{ ...s.td, ...s.tdSku, overflow: "hidden", textOverflow: "ellipsis" }}>
          <input
            type="checkbox"
            checked={selectedIds.has(model.id)}
            onChange={(e) => onToggleRows([model.id], e.target.checked)}
            style={{ ...s.chk, marginRight: 6, verticalAlign: "middle" }}
            title="Marcar para la cotización WhatsApp"
          />
          {v.label}
          {v.collapsed.length > 0 && (
            <span
              style={s.tierTag}
              title={
                `Familia plegada — ${v.colors.length} colores al mismo precio:\n` +
                v.colors.join(" / ") +
                "\n(editar acá actualiza SOLO el color representante; si diverge, se separa solo)"
              }
            >
              {" "}
              {v.colors.length} colores: {v.colors.join("/")}
            </span>
          )}
          {v.collapsed.length === 0 && (
            <select
              value={model.category_id ?? ""}
              onChange={(e) => onSetCategory(model.id, e.target.value === "" ? null : e.target.value)}
              title="Categoría del modelo (mover acá lo cambia de grupo)"
              style={{
                ...s.select,
                border: "none",
                background: "transparent",
                color: "#3d4658",
                fontSize: 10,
                padding: "0 2px",
                marginLeft: 6,
                cursor: "pointer",
              }}
            >
              <option value="">— sin categoría —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </td>
        {deptSuppliers.map((sp) => {
          const v = row.priceBySupplier[sp.id];
          const has = typeof v === "number";
          const state = row.freshBySupplier[sp.id];
          const isFresh = state !== undefined && state !== "expired";
          const isBest = isFresh && agg.count > 0 && v === agg.min;
          const isOut = isFresh && agg.outliers.has(sp.id);
          const tArr = row.tiersBySupplier[sp.id];
          let tierMinQty: number | null = null;
          if (tArr && tArr.length > 1) {
            const cheap = Math.min(...tArr.map((t) => t.price));
            tierMinQty = tArr.find((t) => t.price === cheap)?.min_qty ?? null;
          }
          let bg: CSSProperties | null = null;
          let inColor: CSSProperties | null = null;
          if (isOut) {
            bg = s.cellOut;
            inColor = s.inOut;
          } else if (isBest && state === "recent") {
            bg = s.cellRecentBest; // media celda turquesa / media verde
            inColor = s.inBest;
          } else if (isBest) {
            bg = s.cellBest;
            inColor = s.inBest;
          } else if (state === "recent") {
            bg = s.cellRecent;
            inColor = s.inRecent;
          } else if (state === "updated") {
            bg = s.cellUpdated;
            inColor = s.inUpdated;
          } else if (state === "expired") {
            bg = s.cellExpired;
            inColor = s.inExpired;
          }
          const title =
            [
              state === "expired" && "Expirado — re-pedir",
              state === "recent" && "Recién actualizado (24h)",
              state === "updated" && "Actualizado este ciclo",
              isOut && `Outlier — bajo la mediana ${money(agg.med)} (exceso de stock)`,
              isBest && "Mejor precio (fresco)",
            ]
              .filter(Boolean)
              .join(" · ") || undefined;
          return (
            <td key={sp.id} style={{ ...s.td, ...s.tdCell, ...(bg ?? {}) }} title={title}>
              <span style={s.cellInner}>
                {isOut && "🔥"}
                <EditableNumber
                  value={has ? v : null}
                  onCommit={(n) => onSetPrice(model.id, sp.id, n)}
                  style={{ ...s.cellInput, ...(inColor ?? {}) }}
                  title={title}
                />
                {tierMinQty !== null && tArr && (
                  <span
                    style={s.tierTag}
                    title={
                      "Escala x cantidad:\n" +
                      tArr.map((t) => `${t.min_qty}+ pzs → $${t.price}`).join("\n")
                    }
                  >
                    mín {tierMinQty}u
                  </span>
                )}
              </span>
            </td>
          );
        })}
        <td style={{ ...s.td, ...s.tdNum }}>{money(agg.min)}</td>
        <td style={{ ...s.td, ...s.tdNum, ...s.tdMuted }}>
          {money(agg.med)}
          {spread && (
            <span style={s.deltaTag} title={`Δ ${money(delta)} entre mínimo y medio`}>
              {" "}
              Δ{Math.round(delta)}
            </span>
          )}
        </td>
        <td
          style={{ ...s.td, ...s.tdCell, ...(spread ? s.listaSpread : {}) }}
          title={
            spread
              ? `Spread: mín ${money(agg.min)} / medio ${money(agg.med)} — conviene revisar Lista`
              : undefined
          }
        >
          <EditableNumber
            value={row.salePrice ?? listaAuto}
            onCommit={(n) => onSetLista(model.id, n)}
            style={{ ...s.cellInput, ...(row.salePrice === null ? s.listaAuto : {}) }}
            title={
              row.salePrice === null
                ? `Auto: Mín + ${marginPct}% (escribí para fijar un precio manual; borrá para volver al automático)`
                : "Precio manual (borrá para volver al automático)"
            }
          />
        </td>
        <td
          style={{ ...s.td, ...s.tdNum, ...s.tdMine }}
          title={
            agg.bestIsOutlier
              ? `Outlier — precio sobre mediana ${money(agg.med)} × ${(1 + marginPct / 100).toFixed(3)}`
              : row.clientStale
                ? "Toda la fila expiró — calculado sobre el último mínimo conocido"
                : undefined
          }
        >
          {agg.client !== null ? (
            <>
              {money(agg.client)}
              {agg.bestIsOutlier && <span style={s.medTag}> ·med</span>}
              {row.clientStale && <span style={s.medTag}> ·viejo</span>}
            </>
          ) : (
            <span style={s.dash}>—</span>
          )}
        </td>
      </tr>
    );
  };

  return (
    <>
      <div style={s.tableWrap}>
        <table style={{ ...s.table, tableLayout: "fixed", width: tableWidth, minWidth: 0 }}>
          <thead>
            <tr>
              <ResizableTh colKey="sku" defaultW={DEFAULT_W["sku"]!} style={s.thSku}>
                SKU
              </ResizableTh>
              {deptSuppliers.map((sp) => (
                <ResizableTh key={sp.id} colKey={`sp:${sp.id}`} defaultW={SUPPLIER_W}>
                  {sp.name}
                </ResizableTh>
              ))}
              <ResizableTh colKey="min" defaultW={DEFAULT_W["min"]!}>
                Minimo
              </ResizableTh>
              <ResizableTh colKey="med" defaultW={DEFAULT_W["med"]!}>
                Medio
              </ResizableTh>
              <ResizableTh colKey="lista" defaultW={DEFAULT_W["lista"]!}>
                Lista
              </ResizableTh>
              <ResizableTh colKey="client" defaultW={DEFAULT_W["client"]!} style={s.thMine}>
                {`Client ${marginPct}%`}
              </ResizableTh>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <FragmentGroup
                key={g.category}
                colSpan={colSpanAll}
                group={g}
                render={renderRow}
                selectedIds={selectedIds}
                onToggleRows={onToggleRows}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div style={s.legend}>
        <span>
          <span style={{ ...s.legChip, ...s.cellRecent }} /> recién (24h)
        </span>
        <span>
          <span style={{ ...s.legChip, ...s.cellUpdated }} /> actualizado
        </span>
        <span>
          <span style={{ ...s.legChip, ...s.cellExpired }} /> expirado · re-pedir
        </span>
        <span>
          <span style={{ ...s.legChip, ...s.cellBest }} /> mejor precio
        </span>
        <span>
          <span style={{ ...s.legChip, background: s.cellRecentBest.background }} /> recién + mejor
        </span>
        <span>
          <span style={{ ...s.legChip, ...s.cellOut }} /> 🔥 outlier (&gt;15% bajo mediana)
        </span>
        <span>
          <span style={{ ...s.legChip, borderLeft: "3px solid #7c3aed", background: "#191526" }} />{" "}
          Lista violeta = spread mín≠medio (revisar)
        </span>
        <span>expirados NO cuentan para Minimo/Medio/Client</span>
        <span style={s.tierTag}>mín Nu = escala por cantidad (hover para ver la escalera)</span>
        <span style={s.tierTag}>
          &quot;N colores&quot; = familia iPhone plegada (mismo precio); el color que diverge se
          separa solo
        </span>
      </div>
    </>
  );
}

function FragmentGroup(props: {
  group: MesaCategoryGroup;
  colSpan: number;
  render: (row: MesaVisualRow) => JSX.Element;
  selectedIds: ReadonlySet<string>;
  onToggleRows: (modelIds: readonly string[], on: boolean) => void;
}) {
  // secciones COLAPSABLES: click en el header pliega/despliega (persistido en localStorage)
  const collapsed = useMesaUi((st) => st.collapsedCats[props.group.category] === true);
  const toggleCat = useMesaUi((st) => st.toggleCat);
  const ids = props.group.rows.map((v) => v.row.model.id);
  const allSelected = ids.length > 0 && ids.every((id) => props.selectedIds.has(id));
  return (
    <>
      <tr>
        <td
          colSpan={props.colSpan}
          style={{ ...s.catRow, cursor: "pointer", userSelect: "none" }}
          onClick={() => toggleCat(props.group.category)}
          title="Click: plegar/desplegar la sección"
        >
          <input
            type="checkbox"
            checked={allSelected}
            onChange={(e) => props.onToggleRows(ids, e.target.checked)}
            onClick={(e) => e.stopPropagation()}
            style={{ ...s.chk, marginRight: 6, verticalAlign: "middle" }}
            title="Marcar toda la categoría para la cotización WhatsApp"
          />
          {collapsed ? "▸" : "▾"} {props.group.category}
          <span style={{ color: "#5b657a", fontWeight: 400 }}> ({props.group.rows.length})</span>
        </td>
      </tr>
      {!collapsed && props.group.rows.map(props.render)}
    </>
  );
}
