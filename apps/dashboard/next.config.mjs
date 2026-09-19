/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@brandspace/ui', '@brandspace/shared'],
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
