/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Let a verification build write somewhere other than the live dev server's
  // .next. Without this, NEXT_DIST_DIR is silently ignored and a `next build`
  // run for a CI check overwrites the running `next dev` output — mixing
  // content-hashed production chunks into a dev manifest, which 404s every
  // static asset and leaves a blank page that looks like an app bug.
  distDir: process.env.NEXT_DIST_DIR || '.next',

  transpilePackages: ['@cello/shared'],
  typescript: {
    // Type errors fail the build. `tsc --noEmit` is clean, and letting the build
    // skip validation hid a whole class of invalid-route-export errors.
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'logo.clearbit.com',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'lh3.googleusercontent.com',
        pathname: '/**',
      },
    ],
  },
  // Anti-clickjacking and basic hardening on every response. The app has
  // one-click approve and send actions and embeds nothing, uses no camera,
  // microphone or location, and its OAuth flows are top-level redirects, so none
  // of these affect it. Deliberately no script-src CSP: Next's inline scripts
  // would need per-request nonces, and a half-working one breaks pages.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ]
  },
  // Typed routes disabled for now - causes issues with dynamic routes
  // experimental: {
  //   typedRoutes: true,
  // },
  experimental: {
    // Required for Next 14.1 to load instrumentation.ts's register() hook at
    // all (see that file) — without this flag the file just sits there
    // unused, no error, no warning, register() never runs. This is how
    // lib/observability/sentry.ts gets a chance to init at boot when
    // SENTRY_DSN is set; the flag itself has no runtime cost when it isn't —
    // register() still runs, but initObservability() no-ops synchronously
    // before doing anything.
    instrumentationHook: true,
    // cheerio@1.x depends on undici for its optional fromURL() helper. Once a
    // module chain reaches a bundled route (lib/search -> sourcer -> copilot
    // route), webpack tries to parse undici's ESM and fails the whole compile
    // with "Module parse failed: Unexpected token" — which took the copilot
    // API to a 500. These packages are server-only; leave them external so
    // Node requires them at runtime instead of webpack bundling them.
    // mammoth (.docx -> HTML for resume import) is the same story: it reaches
    // node-only modules and is server-only by nature, so leave it external
    // rather than discover at runtime that a resume upload 500s the way the
    // copilot route did.
    // The Langfuse SDK and its OpenTelemetry peers are server-only and loaded
    // by dynamic import (lib/observability/langfuse.ts); keeping them external
    // stops webpack from bundling them and their node-only dependencies.
    serverComponentsExternalPackages: [
      'cheerio',
      'undici',
      'mammoth',
      'mem0ai',
      '@langfuse/tracing',
      '@langfuse/otel',
      '@langfuse/client',
      '@langfuse/core',
      '@opentelemetry/sdk-trace-base',
      '@opentelemetry/exporter-trace-otlp-http',
      // The agent engine (lib/agents). Large, server-only, and deepagents
      // pulls node-only backends, so they stay external like the Langfuse SDK.
      'deepagents',
      'langchain',
      '@langchain/openrouter',
      '@langchain/mcp-adapters',
    ],
    // lib/harness/prompts.ts reads apps/web/prompts/*.md at RUNTIME via
    // fs.readFileSync(path.join(process.cwd(), 'prompts', ...)). That call is
    // invisible to Next's build-time file tracer (@vercel/nft walks static
    // imports/requires, not a runtime-constructed path) — without this entry,
    // the prompts/ directory works in `next dev` (the files just sit on disk)
    // but never gets copied into a deployed serverless function's bundle,
    // which is a working-in-dev / 404-in-prod bug. '**' is deliberately the
    // broadest route-glob key (matches every traced function) because
    // prompts.ts is imported by whichever agent files adopt it over time —
    // there's no single fixed route to scope this to. See the top-of-file
    // comment in lib/harness/prompts.ts for the full reasoning and the
    // alternative (build-time codegen) this was weighed against.
    outputFileTracingIncludes: {
      // skills/ is read at runtime by the agent's skills backend, the same
      // invisible-to-the-tracer pattern as prompts/.
      '**': ['./prompts/**/*', './skills/**/*'],
    },
  },
}

module.exports = nextConfig
