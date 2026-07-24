// Hook compartido por Cuentas / PnL / Analítica: junta invoices + items + ledger de la
// base y los mapea a los inputs del domain (invoiceInputs.ts). Cada vista compone encima
// lo suyo (clientes/proveedores/modelos para resolver nombres por ID).
import { useMemo } from "react";
import { useInvoiceItems, useInvoices } from "../../data/invoices";
import { useLedger } from "../../data/ledger";
import type { LedgerEntry } from "../../domain/accounts";
import type { DeskInvoice } from "../../domain/analytics";
import { buildDeskInvoices, buildLedgerEntries } from "./invoiceInputs";

export type DeskData = {
  loading: boolean;
  invoices: DeskInvoice[];
  ledger: LedgerEntry[];
};

export function useDeskData(): DeskData {
  const invoices = useInvoices();
  const items = useInvoiceItems();
  const ledger = useLedger();

  const loading = invoices.isLoading || items.isLoading || ledger.isLoading;

  return useMemo(
    () => ({
      loading,
      invoices: buildDeskInvoices(invoices.data ?? [], items.data ?? []),
      ledger: buildLedgerEntries(ledger.data ?? []),
    }),
    [loading, invoices.data, items.data, ledger.data],
  );
}
