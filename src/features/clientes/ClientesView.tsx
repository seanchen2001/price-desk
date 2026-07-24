// Pestaña Clientes: ABM de clientes, envíos y proveedores (después se eligen en Órdenes).
// Paridad con ClientesView.jsx viejo, sobre el stack nuevo: mutaciones por fila
// (insert/update/soft-delete) — clientes y envíos con deleted_at; proveedores se
// "sacan" con active=false (los precios quedan guardados, deja de mostrarse la columna,
// como el viejo) y se reactivan si se vuelve a agregar el mismo nombre.
import { useState } from "react";
import {
  useClients,
  useInsertClient,
  useInsertShipping,
  useShippings,
  useSoftDeleteClient,
  useSoftDeleteShipping,
  useUpdateClient,
  useUpdateShipping,
} from "../../data/clients";
import { useInsertSupplier, useSuppliers, useUpdateSupplier } from "../../data/suppliers";
import s from "../mesa/styles";

const invGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
  gap: 14,
  marginBottom: 6,
} as const;
const invCol = { display: "flex", flexDirection: "column", gap: 5 } as const;
const invColHead = { fontSize: 10, fontWeight: 700, letterSpacing: 1, color: "#6b7385" } as const;
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
const invArea = {
  ...invInput,
  background: "#0b0e14",
  color: "#cfd6e4",
  resize: "vertical" as const,
  lineHeight: 1.4,
} as const;
const chipX = { cursor: "pointer", color: "#8b94a7", fontSize: 14, lineHeight: 1, padding: "0 2px" } as const;
const askHint = { fontSize: 10.5, color: "#525a6b", marginTop: 8 } as const;
const selHint = { fontSize: 10, color: "#525a6b", marginTop: 2 } as const;
const chkLabel = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  marginTop: 4,
  fontSize: 12,
  color: "#cfd6e4",
  cursor: "pointer",
} as const;

type ClientForm = {
  id: string;
  name: string;
  address: string;
  ruc: string;
  phone: string;
  cuentaCorriente: boolean;
  esNuestra: boolean;
};
const blankClient = (): ClientForm => ({
  id: "",
  name: "",
  address: "",
  ruc: "",
  phone: "",
  cuentaCorriente: false,
  esNuestra: false,
});

type ShipForm = {
  id: string;
  label: string;
  notify: string;
  direccion: string;
  telefono: string;
  contacto: string;
};
const blankShip = (): ShipForm => ({
  id: "",
  label: "",
  notify: "",
  direccion: "",
  telefono: "",
  contacto: "",
});

export function ClientesView() {
  const clients = useClients();
  const shippings = useShippings();
  const suppliers = useSuppliers();
  const insertClient = useInsertClient();
  const updateClient = useUpdateClient();
  const softDeleteClient = useSoftDeleteClient();
  const insertShipping = useInsertShipping();
  const updateShipping = useUpdateShipping();
  const softDeleteShipping = useSoftDeleteShipping();
  const insertSupplier = useInsertSupplier();
  const updateSupplier = useUpdateSupplier();

  const clientRows = clients.data ?? [];
  const shipRows = shippings.data ?? [];
  const supplierRows = (suppliers.data ?? []).filter((sp) => sp.active);

  const [clientForm, setClientForm] = useState<ClientForm>(blankClient());
  const [shipForm, setShipForm] = useState<ShipForm>(blankShip());
  const [newSupplier, setNewSupplier] = useState("");
  const [newSupplierCode, setNewSupplierCode] = useState("");
  const [codeDraft, setCodeDraft] = useState<{ id: string; code: string } | null>(null);

  const setClientField = <K extends keyof ClientForm>(k: K, v: ClientForm[K]) =>
    setClientForm((f) => ({ ...f, [k]: v }));
  const setShipField = <K extends keyof ShipForm>(k: K, v: ShipForm[K]) =>
    setShipForm((f) => ({ ...f, [k]: v }));

  function loadClient(id: string) {
    const c = clientRows.find((x) => x.id === id);
    if (!c) {
      setClientForm(blankClient());
      return;
    }
    setClientForm({
      id: c.id,
      name: c.name,
      address: c.address ?? "",
      ruc: c.ruc ?? "",
      phone: c.phone ?? "",
      cuentaCorriente: c.cuenta_corriente,
      esNuestra: c.es_nuestra,
    });
  }

  async function saveClient() {
    const name = clientForm.name.trim();
    if (!name) {
      alert("Poné el nombre del cliente.");
      return;
    }
    const patch = {
      name,
      address: clientForm.address.trim() || null,
      ruc: clientForm.ruc.trim() || null,
      phone: clientForm.phone.trim() || null,
      cuenta_corriente: clientForm.cuentaCorriente,
      es_nuestra: clientForm.esNuestra,
    };
    if (clientForm.id) {
      await updateClient.mutateAsync({ id: clientForm.id, patch });
    } else {
      const row = await insertClient.mutateAsync(patch);
      setClientField("id", row.id);
    }
  }

  async function deleteClient() {
    if (!clientForm.id) return;
    if (!confirm(`¿Borrar el cliente "${clientForm.name}"? (queda en la papelera)`)) return;
    await softDeleteClient.mutateAsync(clientForm.id);
    setClientForm(blankClient());
  }

  function loadShip(id: string) {
    const sh = shipRows.find((x) => x.id === id);
    if (!sh) {
      setShipForm(blankShip());
      return;
    }
    setShipForm({
      id: sh.id,
      label: sh.label,
      notify: sh.notify ?? "",
      direccion: sh.direccion ?? "",
      telefono: sh.telefono ?? "",
      contacto: sh.contacto ?? "",
    });
  }

  async function saveShip() {
    const label = shipForm.label.trim();
    const notify = shipForm.notify.trim();
    if (!label && !notify) {
      alert("Poné al menos la etiqueta o el notify del envío.");
      return;
    }
    const patch = {
      label: label || notify,
      notify: notify || null,
      direccion: shipForm.direccion.trim() || null,
      telefono: shipForm.telefono.trim() || null,
      contacto: shipForm.contacto.trim() || null,
    };
    if (shipForm.id) {
      await updateShipping.mutateAsync({ id: shipForm.id, patch });
    } else {
      const row = await insertShipping.mutateAsync(patch);
      setShipField("id", row.id);
    }
  }

  async function deleteShip() {
    if (!shipForm.id) return;
    if (!confirm(`¿Borrar el envío "${shipForm.label || shipForm.notify}"? (queda en la papelera)`)) return;
    await softDeleteShipping.mutateAsync(shipForm.id);
    setShipForm(blankShip());
  }

  async function addSupplier() {
    const name = newSupplier.trim();
    if (!name) return;
    const code = newSupplierCode.trim() || null;
    const existing = (suppliers.data ?? []).find(
      (sp) => sp.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) {
      // ya existe (activo o sacado): reactivar / actualizar code — nunca duplicar la fila
      await updateSupplier.mutateAsync({
        id: existing.id,
        patch: { active: true, ...(code !== null ? { code } : {}) },
      });
    } else {
      await insertSupplier.mutateAsync({ name, code });
    }
    setNewSupplier("");
    setNewSupplierCode("");
  }

  async function removeSupplier(id: string, name: string) {
    if (!confirm(`¿Sacar el proveedor "${name}"? Sus precios quedan guardados pero deja de mostrarse la columna.`)) return;
    await updateSupplier.mutateAsync({ id, patch: { active: false } });
  }

  async function commitCode() {
    if (!codeDraft) return;
    const row = supplierRows.find((sp) => sp.id === codeDraft.id);
    const code = codeDraft.code.trim() || null;
    setCodeDraft(null);
    if (!row || (row.code ?? null) === code) return;
    await updateSupplier.mutateAsync({ id: codeDraft.id, patch: { code } });
  }

  return (
    <section style={s.section}>
      <div style={s.sectionTitle}>
        CLIENTES Y ENVÍOS — agregar / editar (después se eligen en Órdenes)
      </div>
      <div style={invGrid}>
        <div style={invCol}>
          <div style={invColHead}>CLIENTE</div>
          <select value={clientForm.id} onChange={(e) => loadClient(e.target.value)} style={invInput}>
            <option value="">— nuevo cliente —</option>
            {clientRows.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input placeholder="Nombre" value={clientForm.name} onChange={(e) => setClientField("name", e.target.value)} style={invInput} />
          <textarea placeholder="Dirección (varias líneas)" value={clientForm.address} onChange={(e) => setClientField("address", e.target.value)} rows={2} style={invArea} />
          <input placeholder="RUC" value={clientForm.ruc} onChange={(e) => setClientField("ruc", e.target.value)} style={invInput} />
          <input placeholder="Teléfono" value={clientForm.phone} onChange={(e) => setClientField("phone", e.target.value)} style={invInput} />
          <label style={chkLabel} title="Con cuenta corriente: se envía directo y queda en la cuenta. Sin cuenta: paga primero y después se envía.">
            <input type="checkbox" checked={clientForm.cuentaCorriente} onChange={(e) => setClientField("cuentaCorriente", e.target.checked)} />
            Tiene cuenta corriente
          </label>
          <label style={chkLabel} title="Cuenta propia: lo que se le factura cuenta como COMPRA a inventario (stock in), no como venta.">
            <input type="checkbox" checked={clientForm.esNuestra} onChange={(e) => setClientField("esNuestra", e.target.checked)} />
            Es cuenta nuestra (compras a inventario)
          </label>
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <button onClick={() => void saveClient()} style={s.toolBtn}>
              {clientForm.id ? "Actualizar" : "Guardar"} cliente
            </button>
            {clientForm.id && (
              <button onClick={() => void deleteClient()} style={{ ...s.toolBtn, ...s.toolBtnGhost }}>
                Borrar
              </button>
            )}
          </div>
        </div>

        <div style={invCol}>
          <div style={invColHead}>ENVÍO / SHIPPING</div>
          <select value={shipForm.id} onChange={(e) => loadShip(e.target.value)} style={invInput}>
            <option value="">— nuevo envío —</option>
            {shipRows.map((sh) => (
              <option key={sh.id} value={sh.id}>
                {sh.label || sh.notify}
              </option>
            ))}
          </select>
          <input placeholder="Etiqueta (ej. CIF Miami)" value={shipForm.label} onChange={(e) => setShipField("label", e.target.value)} style={invInput} />
          <input placeholder="Notify" value={shipForm.notify} onChange={(e) => setShipField("notify", e.target.value)} style={invInput} />
          <input placeholder="Dirección de envío" value={shipForm.direccion} onChange={(e) => setShipField("direccion", e.target.value)} style={invInput} />
          <input placeholder="Teléfono" value={shipForm.telefono} onChange={(e) => setShipField("telefono", e.target.value)} style={invInput} />
          <input placeholder="Contacto" value={shipForm.contacto} onChange={(e) => setShipField("contacto", e.target.value)} style={invInput} />
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <button onClick={() => void saveShip()} style={s.toolBtn}>
              {shipForm.id ? "Actualizar" : "Guardar"} envío
            </button>
            {shipForm.id && (
              <button onClick={() => void deleteShip()} style={{ ...s.toolBtn, ...s.toolBtnGhost }}>
                Borrar
              </button>
            )}
          </div>
        </div>

        <div style={invCol}>
          <div style={invColHead}>PROVEEDORES</div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              placeholder="Nuevo proveedor"
              value={newSupplier}
              onChange={(e) => setNewSupplier(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addSupplier();
              }}
              style={{ ...invInput, flex: 1 }}
            />
            <input
              placeholder="Cód."
              title="Código corto para el nombre del remito (PL, Mir, …)"
              value={newSupplierCode}
              onChange={(e) => setNewSupplierCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addSupplier();
              }}
              style={{ ...invInput, width: 44 }}
            />
            <button onClick={() => void addSupplier()} style={s.toolBtn}>
              + Agregar
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
            {supplierRows.map((sp) => (
              <div
                key={sp.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 6,
                  background: "#11151f",
                  border: "1px solid #1c2230",
                  borderRadius: 4,
                  padding: "4px 8px",
                }}
              >
                <span style={{ color: "#cfd6e4" }}>{sp.name}</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <input
                    title="Código corto para el nombre del remito"
                    placeholder="cód."
                    value={codeDraft?.id === sp.id ? codeDraft.code : (sp.code ?? "")}
                    onFocus={() => setCodeDraft({ id: sp.id, code: sp.code ?? "" })}
                    onChange={(e) => setCodeDraft({ id: sp.id, code: e.target.value })}
                    onBlur={() => void commitCode()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                    style={{ ...invInput, width: 44, padding: "2px 6px" }}
                  />
                  <span style={chipX} onClick={() => void removeSupplier(sp.id, sp.name)}>
                    ×
                  </span>
                </span>
              </div>
            ))}
            {supplierRows.length === 0 && <span style={askHint}>Sin proveedores. Agregá al menos uno.</span>}
          </div>
        </div>
      </div>
      <div style={selHint}>
        {clientRows.length} cliente(s) · {shipRows.length} envío(s) · {supplierRows.length} proveedor(es) guardados.
      </div>
    </section>
  );
}
