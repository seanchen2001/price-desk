// Tipos mínimos para importar pdf-parse por su lib interna (evita el "debug mode" del
// index.js del paquete, que en ESM cree que es el módulo principal y lee un PDF de test).
declare module "pdf-parse/lib/pdf-parse.js" {
  type PdfParseResult = { text: string; numpages: number };
  function pdfParse(data: Buffer | Uint8Array): Promise<PdfParseResult>;
  export default pdfParse;
}
