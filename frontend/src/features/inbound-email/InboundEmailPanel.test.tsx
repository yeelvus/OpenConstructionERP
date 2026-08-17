// @ts-nocheck
/**
 * Inbound Email — panel tests.
 *
 *   1. Nothing open reads as nothing open, and says the import is not filed.
 *   2. A parsed message shows the record and every signal's evidence.
 *   3. No signal is stated as a reading of the words, not as an all-clear.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('./api', () => ({
  analyzeInboundEmail: vi.fn(),
}));

import { analyzeInboundEmail } from './api';
import { InboundEmailPanel } from './InboundEmailPanel';

const PARSED = {
  email: {
    message_id: '<msg-1@contractor.test>',
    subject: 'East core handover slipping',
    from_addr: 'site@contractor.test',
    to_addrs: ['pm@client.test'],
    cc_addrs: ['planner@client.test'],
    date_iso: '2026-08-03T09:14:00+00:00',
    in_reply_to: null,
    references: ['<msg-0@client.test>'],
    body_text: 'We were denied access to the east core again this morning.',
    attachments: [{ filename: 'site-photo.jpg', content_type: 'image/jpeg', size_bytes: 24576 }],
  },
  delay_signals: [
    {
      category: 'site_access',
      confidence: 0.82,
      matched_phrases: ['denied access'],
      suggested_activities: ['Record the access restriction', 'Re-sequence the affected work'],
    },
  ],
};

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <InboundEmailPanel />
    </QueryClientProvider>,
  );
}

/** The drop zone hides its input, so the test drives the input directly. */
function fileInput(): HTMLInputElement {
  return document.querySelector('input[type="file"]') as HTMLInputElement;
}

function emlFile(name = 'thread.eml') {
  return new File(['Subject: x\r\n\r\nbody'], name, { type: 'message/rfc822' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('InboundEmailPanel', () => {
  it('says nothing is open, and that an import is not filed', () => {
    renderPanel();

    expect(screen.getByText(/No message open/i)).toBeTruthy();
    expect(screen.getByText(/never filed/i)).toBeTruthy();
  });

  it('shows the record and the evidence behind each signal', async () => {
    (analyzeInboundEmail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(PARSED);
    renderPanel();

    await userEvent.upload(fileInput(), emlFile());

    await waitFor(() => {
      expect(screen.getByText('East core handover slipping')).toBeTruthy();
    });
    expect(screen.getByText('site@contractor.test')).toBeTruthy();
    expect(screen.getByText('planner@client.test')).toBeTruthy();
    expect(screen.getByText('site-photo.jpg')).toBeTruthy();
    expect(screen.getByText(/24\.0 KB/)).toBeTruthy();

    // The category, the confidence, and the phrase that produced it.
    expect(screen.getByText('Site access')).toBeTruthy();
    expect(screen.getByText(/82% confidence/)).toBeTruthy();
    expect(screen.getByText('denied access')).toBeTruthy();
    expect(screen.getByText('Re-sequence the affected work')).toBeTruthy();
  });

  it('reports no match as a reading of the words rather than an all-clear', async () => {
    (analyzeInboundEmail as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...PARSED,
      delay_signals: [],
    });
    renderPanel();

    await userEvent.upload(fileInput(), emlFile());

    await waitFor(() => {
      expect(screen.getByText(/No delay phrase was matched/i)).toBeTruthy();
    });
    expect(screen.getByText(/not a finding about the project/i)).toBeTruthy();
  });
});
