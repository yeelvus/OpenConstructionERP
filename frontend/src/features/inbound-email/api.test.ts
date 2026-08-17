// @ts-nocheck
/**
 * Inbound Email — API client tests.
 *
 * Intercepted with MSW rather than by mocking the helper, because the two
 * things most worth pinning here are invisible to a mocked module: the URL the
 * call goes to, and that the message is sent as multipart with the field name
 * the endpoint reads (`file`). A stubbed `analyzeInboundEmail` would agree with
 * itself about both.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { analyzeInboundEmail } from './api';

const ANALYSIS = {
  email: {
    message_id: '<a@b>',
    subject: 'Access to the east core blocked',
    from_addr: 'site@example.test',
    to_addrs: ['pm@example.test'],
    cc_addrs: [],
    date_iso: '2026-08-03T09:14:00+00:00',
    in_reply_to: null,
    references: [],
    body_text: 'The crane could not be positioned.',
    attachments: [],
  },
  delay_signals: [],
};

let lastUrl: string | null = null;
let lastContentType: string | null = null;
let lastBody: string | null = null;

const server = setupServer(
  http.post('*/api/v1/inbound-email/parse', async ({ request }) => {
    lastUrl = new URL(request.url).pathname;
    lastContentType = request.headers.get('content-type');
    // The raw body rather than request.formData(): jsdom's File comes from a
    // different realm than the undici parser behind MSW, which rejects it. The
    // wire form is the stronger assertion anyway - it is what FastAPI reads.
    lastBody = await request.text();
    return HttpResponse.json(ANALYSIS);
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  lastUrl = null;
  lastContentType = null;
  lastBody = null;
});
afterAll(() => server.close());

function emlFile(name = 'delay.eml') {
  return new File(['Subject: test\r\n\r\nbody'], name, { type: 'message/rfc822' });
}

describe('analyzeInboundEmail', () => {
  it('posts the message to the module endpoint as multipart under "file"', async () => {
    const result = await analyzeInboundEmail(emlFile());

    expect(lastUrl).toBe('/api/v1/inbound-email/parse');
    expect(lastContentType).toMatch(/^multipart\/form-data; boundary=/);
    // A file part, not a text field: FastAPI binds `UploadFile` only when the
    // part carries a filename. The name itself is not asserted because jsdom's
    // File loses it on the way through undici and arrives as "blob"; a browser
    // sends the real one, and the endpoint reads the bytes either way.
    expect(lastBody).toMatch(/Content-Disposition: form-data; name="file"; filename=/);
    expect(lastBody).toContain('message/rfc822');
    expect(result.email.subject).toBe('Access to the east core blocked');
  });

  it('raises the server explanation rather than a bare status', async () => {
    server.use(
      http.post('*/api/v1/inbound-email/parse', () =>
        HttpResponse.json({ detail: 'That file is not a stored message.' }, { status: 400 }),
      ),
    );

    await expect(analyzeInboundEmail(emlFile('notes.txt'))).rejects.toThrow(
      /not a stored message/,
    );
  });

  it('still raises something readable when the error body is not JSON', async () => {
    server.use(
      http.post('*/api/v1/inbound-email/parse', () =>
        HttpResponse.text('gateway said no', { status: 502 }),
      ),
    );

    await expect(analyzeInboundEmail(emlFile())).rejects.toThrow(/502/);
  });
});
