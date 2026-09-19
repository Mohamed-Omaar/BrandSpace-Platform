import { createServer } from 'node:http';

/**
 * A stand-in for Resend's HTTP API, at the NETWORK boundary and nowhere else.
 *
 * WHY THIS EXISTS RATHER THAN A STUBBED PROVIDER. The end-to-end proof is that
 * an owner configuring Resend in the Control Center changes which adapter a
 * customer signup reaches. Replacing the provider — or the resolver, or the
 * configuration read — would prove only that the stub was installed. So every
 * link in the chain is the real one, right down to `ResendEmailProvider`
 * composing an HTTP request; the only substitution is the host that request
 * arrives at.
 *
 * NO REAL CREDENTIAL, EVER. This process accepts any Authorization header and
 * contacts nothing. Nothing in the suite has, or needs, a Resend account.
 *
 * WHAT IT RECORDS. Enough to assert what BrandSpace SENT — recipient, subject,
 * whether a link is present — and, deliberately, the Authorization header, so a
 * test can prove the key travelled in the header and nowhere else. The recorded
 * key is the fixture's, which is not a credential.
 *
 * IT SERVES ONLY `POST /emails`, because that is the only Resend operation the
 * product performs. A `GET /domains` handler lived here while the Control
 * Center had a Test Connection button; both are gone, since the credential
 * BrandSpace asks for is a Sending-access key that Resend refuses every read
 * to. A stand-in that answered a call the product never makes would let a
 * re-added read pass its tests against a fake more permissive than the vendor.
 */

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string;
  readonly body: unknown;
}

const recorded: RecordedRequest[] = [];

const port = Number(process.env['FAKE_RESEND_PORT'] ?? 3105);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

  /*
   * THE SUITE'S OWN READ SURFACE, namespaced so it cannot collide with a path
   * Resend defines. A spec asks this for what arrived; it is not part of the
   * emulated API.
   */
  if (url.pathname === '/__recorded') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(recorded));
    return;
  }
  if (url.pathname === '/__reset') {
    recorded.length = 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"reset":true}');
    return;
  }

  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    recorded.push({
      method: req.method ?? '',
      path: url.pathname,
      authorization: String(req.headers['authorization'] ?? ''),
      body,
    });

    // `POST /emails` — the send. Answers with a provider message id, which is
    // what the adapter returns and what makes a delivery traceable.
    if (url.pathname === '/emails') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `fake-message-${recorded.length}` }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"name":"not_found"}');
  });
});

server.listen(port, '127.0.0.1', () => {
  // The readiness line Playwright's `webServer` waits for.
  process.stdout.write(`fake resend listening on ${port}\n`);
});
