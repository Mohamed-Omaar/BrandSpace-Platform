/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@brandspace/ui', '@brandspace/shared'],
  /*
   * NO IMAGE OPTIMISER. No screen renders through `next/image` (the asset
   * grid uses a plain `img` on purpose), so `/_next/image` would serve nobody
   * and is an unauthenticated endpoint that has carried critical advisories
   * (GHSA-2464-fhr4-w9xw, GHSA-cjq9-62q9-8jv4). `unoptimized` turns it off.
   */
  images: { unoptimized: true },
  /*
   * SECURITY HEADERS LIVE IN `src/proxy.ts` (Phase 10 §21), not here.
   * Content-Security-Policy needs a per-request nonce, and Next.js reads
   * that nonce off the REQUEST headers to stamp its own inline scripts —
   * which a static `headers()` block cannot provide. Declaring the other
   * four here as well would leave two copies of one policy, and the weaker
   * copy is the one somebody eventually edits.
   */
};

export default nextConfig;
