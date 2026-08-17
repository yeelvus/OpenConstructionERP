// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
//
// Component tests for <EInvoiceModal>.
//
// The panel exists to make one distinction legible, and that distinction is
// what these tests pin. An EN 16931 rule violation comes in two strengths:
// a fatal one means the receiver refuses the document, an advisory one means
// the document is issuable and could still be better. Both arrive in the same
// list from the same endpoint. A screen that renders them the same way either
// blocks an invoice that was fine or offers a download that will 422, and in
// both cases everything on screen looks healthy.
//
// The rule identifiers are asserted verbatim on purpose. BR-61 is the string a
// tax portal will quote back at the sender, so it is the part of the message
// with operational value, and a refactor that keeps the prose while dropping
// the id would leave the panel looking correct and be useless in practice.
//
// The i18n mock in src/test/setup.ts returns the key itself when a call passes
// no defaultValue, so the keys below are what the component renders here.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Only the two calls this panel makes are replaced. The rest of the module
// stays real because <Button> comes from the shared barrel, which drags in
// every component beside it, and several of those read API_BASE or ApiError at
// module-eval time. A mock listing three exports leaves those undefined and the
// suite fails on import with nothing on screen to explain why.
vi.mock('@/shared/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/shared/lib/api')>('@/shared/lib/api');
  return {
    ...actual,
    apiGet: vi.fn(),
    downloadWithAuth: vi.fn(),
  };
});

import { EInvoiceModal } from './EInvoiceModal';
import * as api from '@/shared/lib/api';

const apiGetMock = vi.mocked(api.apiGet);
const downloadMock = vi.mocked(api.downloadWithAuth);

const INVOICE_ID = 'inv-1';

const PROFILES = {
  profiles: [
    { key: 'xrechnung', label: 'XRechnung 3.0', syntax: 'cii', region: 'DE' },
    { key: 'peppol', label: 'Peppol BIS Billing 3.0', syntax: 'ubl', region: 'international' },
  ],
};

/** The advisory the exporter raises when no bank account is on file. */
const NO_ACCOUNT = {
  rule_id: 'OCE-PAY-01',
  severity: 'warning',
  message: 'Add a payment account so the buyer knows where to pay.',
  term: 'BT-84',
};

/** A real blocker: XRechnung requires the buyer reference. */
const NO_BUYER_REF = {
  rule_id: 'BR-DE-15',
  severity: 'fatal',
  message: 'Add the Buyer reference (BT-10) required by this profile.',
  term: 'BT-10',
};

/** A finding only the Peppol profile raises, so its arrival is observable. */
const PEPPOL_ONLY = {
  rule_id: 'PEPPOL-EN16931-R020',
  severity: 'warning',
  message: 'Seller electronic address is recommended for Peppol delivery.',
  term: 'BT-34',
};

type DryRun = {
  format: string;
  valid: boolean;
  problems: string[];
  violations: typeof NO_ACCOUNT[];
};

function dryRun(over: Partial<DryRun> = {}): DryRun {
  return {
    format: 'xrechnung',
    valid: true,
    problems: [],
    violations: [NO_ACCOUNT],
    ...over,
  };
}

/**
 * Route apiGet by URL so profile and dry-run answers cannot be swapped, and
 * answer each profile with its own verdict. A single shared answer would let a
 * panel that ignores the picker pass, because the reply would look the same
 * whichever profile it was asked about.
 */
function respond(runs: Record<string, DryRun> = {}) {
  apiGetMock.mockImplementation((url: string) => {
    if (url.includes('einvoice-profiles')) return Promise.resolve(PROFILES);
    const asked = /format=([^&]+)/.exec(url)?.[1] ?? '';
    return Promise.resolve(runs[asked] ?? dryRun({ format: asked }));
  });
}

function renderModal() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <EInvoiceModal
        open
        onClose={vi.fn()}
        invoiceId={INVOICE_ID}
        invoiceNumber="RE-2026-77"
      />
    </QueryClientProvider>,
  );
}

function xmlButton(): HTMLButtonElement {
  return screen.getByText('finance.einvoice.downloadXml').closest('button')!;
}

describe('EInvoiceModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('leaves the download available when the only finding is an advisory', async () => {
    respond();
    renderModal();

    await screen.findByText('finance.einvoice.advisoryTitle');
    // The invoice is issuable, so nothing here may stop the export.
    expect(screen.queryByText('finance.einvoice.blockingTitle')).toBeNull();
    expect(xmlButton()).not.toBeDisabled();
  });

  it('blocks the download when a rule is fatal', async () => {
    respond({
      xrechnung: dryRun({
        valid: false,
        problems: [NO_BUYER_REF.message],
        violations: [NO_BUYER_REF, NO_ACCOUNT],
      }),
    });
    renderModal();

    await screen.findByText('finance.einvoice.blockingTitle');
    expect(xmlButton()).toBeDisabled();
  });

  it('shows the advisory even when a fatal rule is also present', async () => {
    // A blocker must not swallow the advice sitting next to it, or the user
    // fixes one thing, re-checks, and is told about the next one only then.
    respond({
      xrechnung: dryRun({
        valid: false,
        problems: [NO_BUYER_REF.message],
        violations: [NO_BUYER_REF, NO_ACCOUNT],
      }),
    });
    renderModal();

    await screen.findByText('BR-DE-15');
    expect(screen.getByText('OCE-PAY-01')).toBeInTheDocument();
  });

  it('prints the rule id a receiver would quote, not only the sentence', async () => {
    respond();
    renderModal();

    await screen.findByText('OCE-PAY-01');
    expect(screen.getByText(NO_ACCOUNT.message)).toBeInTheDocument();
  });

  it('offers every profile the registry publishes rather than a built-in list', async () => {
    respond();
    renderModal();

    // Wait for the options, not for the select: the select is on screen from
    // the first render and is empty until the registry answers, so waiting on
    // the combobox alone would read the picker before it has anything in it.
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual([
      'xrechnung',
      'peppol',
    ]);
  });

  it('re-checks against the profile the user picked and downloads that one', async () => {
    respond({ peppol: dryRun({ format: 'peppol', violations: [PEPPOL_ONLY] }) });
    renderModal();

    await screen.findAllByRole('option');
    await screen.findByText('OCE-PAY-01');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'peppol' } });

    // The download stays shut until the new verdict lands, because a file
    // offered mid-recheck was cleared against the profile the user just left.
    expect(xmlButton()).toBeDisabled();

    // The panel now shows the Peppol answer, not the German one it had.
    await screen.findByText('PEPPOL-EN16931-R020');
    expect(screen.queryByText('OCE-PAY-01')).toBeNull();

    fireEvent.click(xmlButton());
    await waitFor(() => expect(downloadMock).toHaveBeenCalled());
    expect(downloadMock.mock.calls[0]![0]).toContain('format=peppol');
  });

  it('does not offer a hybrid PDF on a profile that has no hybrid form', async () => {
    // Factur-X embeds CII inside the PDF and nothing embeds UBL, so the
    // server refuses embed=true for Peppol. A button that can only produce
    // that refusal is worse than no button: it reads as a supported export.
    respond();
    renderModal();

    await screen.findAllByRole('option');
    expect(screen.getByText('finance.einvoice.downloadPdf')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'peppol' } });

    await waitFor(() =>
      expect(screen.queryByText('finance.einvoice.downloadPdf')).toBeNull(),
    );
    // The XML export is the one Peppol actually uses, and it stays.
    expect(screen.getByText('finance.einvoice.downloadXml')).toBeInTheDocument();
  });

  it('asks for the XML and the hybrid PDF on the same route, one embedded', async () => {
    respond();
    renderModal();

    await screen.findAllByRole('option');
    await screen.findByText('OCE-PAY-01');

    fireEvent.click(xmlButton());
    await waitFor(() => expect(downloadMock).toHaveBeenCalledTimes(1));
    expect(downloadMock.mock.calls[0]![0]).toContain('embed=false');

    fireEvent.click(screen.getByText('finance.einvoice.downloadPdf').closest('button')!);
    await waitFor(() => expect(downloadMock).toHaveBeenCalledTimes(2));
    expect(downloadMock.mock.calls[1]![0]).toContain('embed=true');
  });

  it('shows the server message when the download is refused', async () => {
    // The export can still fail on something the dry run did not model, and
    // a silent failure here looks exactly like a successful download.
    respond();
    downloadMock.mockRejectedValueOnce(new Error('invoice is not EN 16931 complete'));
    renderModal();

    await screen.findByText('OCE-PAY-01');
    fireEvent.click(xmlButton());

    expect(await screen.findByText('invoice is not EN 16931 complete')).toBeInTheDocument();
  });
});
