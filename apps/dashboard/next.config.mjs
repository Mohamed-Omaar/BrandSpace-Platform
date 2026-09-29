/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@brandspace/ui', '@brandspace/shared'],
  /*
   * PHASE 2C-4 — THE TRANSPORT CEILING FOR A 20 MiB BRAND BRAIN SOURCE.
   *
   * Next.js refuses a Server Action body over 1 MB, and buffers at most 10 MB
   * of a request for the middleware (`proxyClientMaxBodySize`), so a 20 MiB
   * document never reached the upload action at all. Both are raised to
   * 24 MiB (25,165,824 bytes): the approved file ceiling, 20 * 1024 * 1024 =
   * 20,971,520 bytes, plus room for the multipart envelope and the form's
   * other fields.
   *
   * THIS IS TRANSPORT, NOT THE RULE. The document limit is the configured
   * `brand-brain.upload.maxFileBytes`, enforced server-side by the ingestion
   * service, where a file over it becomes a FAILED source row. A file past
   * this transport ceiling is refused by Next.js before our code runs.
   */
  experimental: {
    serverActions: { bodySizeLimit: '24mb' },
    proxyClientMaxBodySize: '24mb',
  },
  /*
   * SECURITY HEADERS LIVE IN `src/middleware.ts` (Phase 10 §21), not here.
   * Content-Security-Policy needs a per-request nonce, and Next.js reads
   * that nonce off the REQUEST headers to stamp its own inline scripts —
   * which a static `headers()` block cannot provide. Declaring the other
   * four here as well would leave two copies of one policy, and the weaker
   * copy is the one somebody eventually edits.
   */
};

export default nextConfig;
