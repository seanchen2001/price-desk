// Fase 6 — PDF: renderiza InvoiceDoc (factura y remito) y RemitosDoc con
// @react-pdf/renderer REAL, escribe a /tmp y verifica con pdf-parse que el layout
// lleva los campos del template del trader (AC: idénticos a los actuales).
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { renderToBuffer } from "@react-pdf/renderer";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { COMPANY, type ClientPdf } from "../src/domain/orders";
import { InvoiceDoc, RemitosDoc, type PdfOrder } from "../src/features/pdf/InvoiceDoc";

const CLIENT: ClientPdf = {
  name: "Cliente Demo Fase 6",
  ruc: "80099887-1",
  phone: "0991 555 111",
  addressLines: ["Av. Siempre Viva 742", "Ciudad del Este"],
  notify: "Ojus LLC",
  direccion: "2100 NW 92nd Ave, Miami FL",
  telefono: "305 555 0100",
  contacto: "Juan",
};

const ORDER: PdfOrder = {
  invoiceNo: "2504",
  date: "21/7/2026",
  payment: "W/T",
  fob: "Miami",
  salesperson: "MG",
  job: "",
  terms: "Due upon receipt",
  dueDate: "21/7/2026",
  shippingCost: 80,
  items: [
    { qty: 3, modelName: "A07 4+64 DS", category: "Samsung", color: "BLACK", imei: "", spec: "", price: 620 },
    {
      qty: 2,
      modelName: "MOTO G06 4+64",
      category: "Motorola LATIN",
      color: "AZUL",
      imei: "",
      spec: "LATIN",
      price: 410,
    },
  ],
};

describe("InvoiceDoc (factura)", () => {
  it("renderiza, pesa > 0 y contiene los textos clave del template", async () => {
    const buf = await renderToBuffer(
      <InvoiceDoc company={COMPANY} client={CLIENT} order={ORDER} mode="factura" />,
    );
    writeFileSync("/tmp/f6-factura.pdf", buf);
    expect(buf.length).toBeGreaterThan(0);

    const parsed = await pdfParse(buf);
    expect(parsed.numpages).toBe(1);
    const text = parsed.text;
    // header + meta
    expect(text).toContain("PHOTO IMAGEN & VIDEO EXPORT LLC");
    expect(text).toContain("Invoice #:");
    expect(text).toContain("2504");
    expect(text).toContain("W/T");
    expect(text).toContain("Miami");
    // cliente
    expect(text).toContain("Cliente Demo Fase 6");
    expect(text).toContain("RUC: 80099887-1");
    expect(text).toContain("Av. Siempre Viva 742");
    // grilla salesperson
    expect(text).toContain("Salesperson");
    expect(text).toContain("Payment Terms");
    expect(text).toContain("Due upon receipt");
    // items: marca Samsung antepuesta; Motorola ya trae la marca; spec al final
    expect(text).toContain("Samsung A07 4+64 DS - BLACK");
    expect(text).toContain("MOTO G06 4+64 - AZUL - LATIN");
    // totales: 3*620 + 2*410 = 2680; total con envío 2760; y el line total de la 1ª línea
    expect(text).toContain("Line Total");
    expect(text).toContain("$1,860.00");
    expect(text).toContain("$2,680.00");
    expect(text).toContain("$2,760.00");
    expect(text).toContain("Total Piezas:");
    expect(text).toContain("5");
    // shipping box
    expect(text).toContain("Notify:");
    expect(text).toContain("Ojus LLC");
    expect(text).toContain("2100 NW 92nd Ave, Miami FL");
    expect(text).toContain("Thank you for your business!");
  });

  it("modo remito: sin precios ni Line Total ni Subtotal", async () => {
    const buf = await renderToBuffer(
      <InvoiceDoc company={COMPANY} client={CLIENT} order={ORDER} mode="remito" />,
    );
    writeFileSync("/tmp/f6-remito.pdf", buf);
    const text = (await pdfParse(buf)).text;
    expect(text).toContain("Total Piezas:");
    expect(text).toContain("Samsung A07 4+64 DS - BLACK");
    expect(text).not.toContain("Line Total");
    expect(text).not.toContain("Subtotal");
    expect(text).not.toContain("$620.00");
  });
});

describe("RemitosDoc (por proveedor)", () => {
  it("una página por proveedor, cada una solo con sus items", async () => {
    const groups = [
      {
        supplierName: "planET",
        client: CLIENT,
        order: { ...ORDER, items: [ORDER.items[0]!] },
      },
      {
        supplierName: "VITEL",
        client: CLIENT,
        order: { ...ORDER, items: [ORDER.items[1]!] },
      },
    ];
    const buf = await renderToBuffer(<RemitosDoc company={COMPANY} groups={groups} />);
    writeFileSync("/tmp/f6-remitos-prov.pdf", buf);
    const parsed = await pdfParse(buf);
    expect(parsed.numpages).toBe(2);
    // items de ambos proveedores presentes, sin datos del proveedor en el documento
    expect(parsed.text).toContain("Samsung A07 4+64 DS - BLACK");
    expect(parsed.text).toContain("MOTO G06 4+64 - AZUL - LATIN");
    expect(parsed.text).not.toContain("planET");
    expect(parsed.text).not.toContain("VITEL");
  });
});
