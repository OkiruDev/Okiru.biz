# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   ├── api-server/         # Express API server
│   └── okiru-toolkit/      # Okiru AI Tool Advisor (single-file toolkit.html)
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/                # Utility scripts (single workspace package)
│   └── src/                # Individual .ts scripts, run via `pnpm --filter @workspace/scripts run <script>`
├── pnpm-workspace.yaml     # pnpm workspace (artifacts/*, lib/*, lib/integrations/*, scripts)
├── tsconfig.base.json      # Shared TS options (composite, bundler resolution, es2022)
├── tsconfig.json           # Root TS project references
└── package.json            # Root package with hoisted devDeps
```

## Okiru AI Tool Advisor (artifacts/okiru-toolkit)

Static React-Vite shell that redirects `/` → `/toolkit.html` (a hand-built
single-file site, ~4860 lines). Canonical domain: `https://www.okiru.biz/ai-tool-advisor`.

### Okiru brand map (do not confuse)

- **okiru.biz** — the **free AI Tool Advisor** (this codebase). Also served on
  okiru.dev. Path-based at `/ai-tool-advisor`.
- **okiru.pro** — a **separate product**: the transformation toolkit for
  **B-BBEE, ESG, WSP/ATR (Workplace Skills Plan / Annual Training Report),
  and Employment Equity (EE)**. Built for South African compliance teams.
  Linked from the home welcome card; not part of this codebase. Never
  describe okiru.pro as "the premium AI Tool Advisor" — that is wrong.
- **okiru.co.za** — Okiru Consulting (parent firm: AI strategy, custom
  chatbots, workflow automation, document intelligence, AI training).

### Referral / affiliate routing

All outbound "Open Tool" CTAs are routed through `getOpenUrl(t)` which looks up
an optional tracking URL in the `REFERRAL_URLS` map (keyed by exact tool name,
defined just above the `tools` array in `public/toolkit.html`). To monetise a
tool, paste the tracking URL into the matching key. Empty string falls back to
the canonical `t.url`.

- **Where the map lives**: `REFERRAL_URLS` block in `public/toolkit.html`
  (~line 1876). Tier 1 / Tier 2 / Tier 3 tools are pre-listed with affiliate
  program + commission notes in inline comments.
- **Security**: pasted URLs pass through `isSafeUrl(u)` — http(s) only,
  ASCII-only printable, length ≤ 2048, blocks quotes / backticks / angle
  brackets / backslash / HTML-entity prefixes (`&#…`, `&name;`). Any URL that
  fails the gate silently falls through to `t.url`.
- **No inline interpolation**: outbound URLs are *never* interpolated into
  HTML strings. All CTAs use `data-open-tool="<name>"` and a single
  document-level delegated click handler that resolves the URL at click time
  and calls `window.open(url, "_blank", "noopener,noreferrer")`.
- **SEO preserved**: `t.url` is left intact in JSON-LD schema, FAQ generator
  text, and pricing copy so search engines see canonical URLs, not the
  affiliate redirects.
- **FTC disclosure**: footer carries a global affiliate disclosure block;
  the side panel and advisor/compare/featured CTAs each show a proximate
  "✦ Affiliate link" note when `hasReferral(t)` is true.

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references. This means:

- **Always typecheck from the root** — run `pnpm run typecheck` (which runs `tsc --build --emitDeclarationOnly`). This builds the full dependency graph so that cross-package imports resolve correctly. Running `tsc` inside a single package will fail if its dependencies haven't been built yet.
- **`emitDeclarationOnly`** — we only emit `.d.ts` files during typecheck; actual JS bundling is handled by esbuild/tsx/vite...etc, not `tsc`.
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array. `tsc --build` uses this to determine build order and skip up-to-date packages.

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages that define it
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Packages

### `artifacts/api-server` (`@workspace/api-server`)

Express 5 API server. Routes live in `src/routes/` and use `@workspace/api-zod` for request and response validation and `@workspace/db` for persistence.

- Entry: `src/index.ts` — reads `PORT`, starts Express
- App setup: `src/app.ts` — mounts CORS, JSON/urlencoded parsing, routes at `/api`
- Routes: `src/routes/index.ts` mounts sub-routers; `src/routes/health.ts` exposes `GET /health` (full path: `/api/health`)
- Depends on: `@workspace/db`, `@workspace/api-zod`
- `pnpm --filter @workspace/api-server run dev` — run the dev server
- `pnpm --filter @workspace/api-server run build` — production esbuild bundle (`dist/index.cjs`)
- Build bundles an allowlist of deps (express, cors, pg, drizzle-orm, zod, etc.) and externalizes the rest

### `lib/db` (`@workspace/db`)

Database layer using Drizzle ORM with PostgreSQL. Exports a Drizzle client instance and schema models.

- `src/index.ts` — creates a `Pool` + Drizzle instance, exports schema
- `src/schema/index.ts` — barrel re-export of all models
- `src/schema/<modelname>.ts` — table definitions with `drizzle-zod` insert schemas (no models definitions exist right now)
- `drizzle.config.ts` — Drizzle Kit config (requires `DATABASE_URL`, automatically provided by Replit)
- Exports: `.` (pool, db, schema), `./schema` (schema only)

Production migrations are handled by Replit when publishing. In development, we just use `pnpm --filter @workspace/db run push`, and we fallback to `pnpm --filter @workspace/db run push-force`.

### `lib/api-spec` (`@workspace/api-spec`)

Owns the OpenAPI 3.1 spec (`openapi.yaml`) and the Orval config (`orval.config.ts`). Running codegen produces output into two sibling packages:

1. `lib/api-client-react/src/generated/` — React Query hooks + fetch client
2. `lib/api-zod/src/generated/` — Zod schemas

Run codegen: `pnpm --filter @workspace/api-spec run codegen`

### `lib/api-zod` (`@workspace/api-zod`)

Generated Zod schemas from the OpenAPI spec (e.g. `HealthCheckResponse`). Used by `api-server` for response validation.

### `lib/api-client-react` (`@workspace/api-client-react`)

Generated React Query hooks and fetch client from the OpenAPI spec (e.g. `useHealthCheck`, `healthCheck`).

### `scripts` (`@workspace/scripts`)

Utility scripts package. Each script is a `.ts` file in `src/` with a corresponding npm script in `package.json`. Run scripts via `pnpm --filter @workspace/scripts run <script>`. Scripts can import any workspace package (e.g., `@workspace/db`) by adding it as a dependency in `scripts/package.json`.

### `artifacts/okiru-toolkit` (`@workspace/okiru-toolkit`)

React + Vite app that hosts the static **Okiru AI Tool Advisor** (single-file `public/toolkit.html`). The React shell at `src/App.tsx` redirects `/` → `/toolkit.html`. All toolkit logic, data, and styling live inside `public/toolkit.html` (~4000 lines, 195 AI tools across 14 categories).

**SEO + per-tool indexing**

- **Deep links**: each tool has a canonical URL `https://www.okiru.co.za/bee-toolkit?tool=<name+with+spaces>`. Visiting one auto-skips the welcome screen and opens that tool's panel.
- **Per-tool meta**: on init/openPanel/closePanel, JS updates `<title>`, `meta[name=description]`, `og:title`, `og:description`, `og:url`, and `<link rel=canonical>` to match the active tool (or restores defaults).
- **JSON-LD**: two `<script type="application/ld+json">` blocks in `<head>`:
  - `#seo-jsonld-base` — `WebSite` + `ItemList` of all tools (always populated).
  - `#seo-jsonld-tool` — `SoftwareApplication` + `FAQPage` for the active tool (populated when a tool is open, cleared on close).
- **Visible directory**: `<section id="tool-directory">` at the bottom of the page lists every tool grouped by category as clickable `<a>` links (no hidden/cloaked SEO content). Clicks are intercepted to call `openPanel()` without a page reload.
- **FAQ section**: each tool's drawer renders 6–7 auto-generated Q&As (`buildToolFaq`) inside `#bp-faq` as `<details class="bp-faq-item">`, mirroring the FAQPage JSON-LD.
- **History**: `openPanel`/`closePanel` use `history.pushState` (raw tool name via `URLSearchParams`); a `popstate` handler re-syncs the panel for back/forward navigation.
- **Static SEO files** in `public/`:
  - `sitemap.xml` — homepage + 195 tool deep-link URLs (regenerate via the Node one-liner in the toolkit's history when tools change).
  - `robots.txt` — references `https://www.okiru.co.za/sitemap.xml`.
  - `googleed9c89e7d0c919fb.html` — Google Search Console verification token.
