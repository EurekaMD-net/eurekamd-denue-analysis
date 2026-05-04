# Analyzer v1.0 — Final Plan

> **Author**: Claude (operator-side, mc bypass — Jarvis not assigned)
> **Sealed**: 2026-05-04 03:30 UTC
> **Scope owner**: operator (Fede)
> **Builder**: Claude in operator's Claude Code session
> **Survives**: compaction — plan is read from disk on resume

## Goal (one line)

Ship a queryable, browser-based analyzer over the 6.1M-record DENUE dataset already in Supabase, with two modes (Map + Locust), live at `https://analyzer.denue.net`, in 25–35 hours of focused work over 3–5 sessions.

## Sealed decisions (no more deliberation)

| #   | Decision              | Value                                                                                                                                                                        |
| --- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Repo location         | `denue-data-analysis/web/` subdirectory in the same `EurekaMD-net/eurekamd-denue-analysis` GitHub repo                                                                       |
| 2   | Auth model for MVP    | Single `X-Api-Key` (existing pattern). Stored in browser `localStorage`. NO SSO, NO JWT. Defer real auth post-MVP.                                                           |
| 3   | Public subdomain      | `analyzer.denue.net` — Caddy reverse proxy + Let's Encrypt TLS, same VPS                                                                                                     |
| 4   | Map base style        | Carto Positron (light) + Carto Dark Matter (toggle) — free OpenStreetMap tiles, no Mapbox token                                                                              |
| 5   | README reconciliation | DONE before P0. Jarvis's recent README rewrite has hallucinations (CDMX 380k vs real 460,866; wrong endpoint names; wrong deps). Fix first so we don't code against fiction. |
| 6   | Push target           | Same repo `EurekaMD-net/eurekamd-denue-analysis`, branch `main`, conventional commits per `feat(analyzer)`/`fix(analyzer)` prefix                                            |
| 7   | MVP feature scope     | 4 hero use cases ONLY. No Censo/CONEVAL dependency. v2.0 picks up Phase 1 data when Jarvis ships it.                                                                         |
| 8   | Visual polish         | Intentionally raw — no design system, no Storybook, no animations. Tailwind utility classes + system fonts.                                                                  |

## Frozen stack

```
Frontend:  React 18 + TypeScript + Vite 5
Routing:   react-router-dom v7 (file-system routes)
State:     Zustand (UI state) + TanStack Query v5 (server state, 5-min stale)
Map:       maplibre-gl + deck.gl/react + deck.gl/layers
Charts:    echarts + echarts-for-react
Styling:   tailwindcss v3 + @tailwindcss/forms
Validation: zod (mirrored across client/server)
Build:     vite build → dist/ static
Deploy:    Caddy reverse proxy (existing), TLS via Let's Encrypt
Test:      vitest (frontend), existing vitest config for backend
```

**No other dependencies.** If a new package is needed mid-build, STOP and confirm with operator first.

## Repo layout (target end-state)

```
denue-data-analysis/
├── src/
│   ├── api/                           # existing Hono API (Phase 5)
│   │   └── handlers/
│   │       ├── tiles.ts               # NEW — vector tile endpoint (P1)
│   │       ├── entidades.ts           # NEW — dropdown source (P1)
│   │       └── sectors.ts             # NEW — dropdown source (P1)
│   ├── extractor/                     # existing (Phase 1)
│   ├── db/                            # existing (Phase 2)
│   ├── pipeline/                      # existing (Phase 3)
│   └── analysis/                      # existing (Phase 4)
├── web/                               # NEW — analyzer frontend
│   ├── package.json                   # separate, only frontend deps
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   ├── tsconfig.json
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx                   # entry
│   │   ├── App.tsx                    # router shell
│   │   ├── store.ts                   # Zustand global UI state
│   │   ├── api/
│   │   │   ├── client.ts              # fetch wrapper, X-Api-Key injection
│   │   │   ├── types.ts               # Zod schemas mirroring backend types.ts
│   │   │   └── queries.ts             # TanStack Query hooks
│   │   ├── components/
│   │   │   ├── Layout.tsx             # sidebar + main + mode toggle
│   │   │   ├── ApiKeyGate.tsx         # first-load API key prompt
│   │   │   ├── FilterPanel.tsx        # entidad + sector dropdowns
│   │   │   ├── EstablishmentCard.tsx  # detail panel for clicked pin
│   │   │   └── ErrorBoundary.tsx
│   │   ├── modes/
│   │   │   ├── MapMode.tsx            # MapLibre + deck.gl orchestration
│   │   │   ├── LocustMode.tsx         # ECharts orchestration
│   │   │   └── layers/                # deck.gl layer factories
│   │   │       ├── HeatmapLayer.ts
│   │   │       └── ClusterLayer.ts
│   │   └── lib/
│   │       └── tile-url.ts            # tile URL builder for MapLibre source
│   └── public/
│       └── favicon.svg
├── docs/
│   ├── analyzer-plan-v1.md            # ← this file
│   └── ... (existing)
└── package.json                       # backend (untouched)
```

## API additions (P1 spec)

### `GET /entidades`

Auth: X-Api-Key. Returns dropdown source.

```json
{
  "entidades": [
    { "clave": "01", "nombre": "Aguascalientes", "loaded": 71278, "inegi_total": null, "status": "unverified" },
    { "clave": "06", "nombre": "Colima",         "loaded": 41765, "inegi_total": 41756, "status": "green" },
    ...
  ]
}
```

Source: `mv_coverage` joined with `inegi_authoritative_counts.json` + the `ESTADOS` map from `src/extractor/types.ts`.

### `GET /sectors`

Auth: X-Api-Key. Returns dropdown source for SCIAN 2-digit prefixes.

```json
{
  "sectors": [
    { "scian": "11", "name": "Agricultura, ganadería, aprovechamiento forestal, pesca y caza", "national_count": 84321 },
    { "scian": "21", "name": "Minería",                                                         "national_count": 4012 },
    ...
  ]
}
```

Source: aggregate over `establecimientos` grouped by `SUBSTR(clee, 6, 2)` — the 2-digit SCIAN sector lives at chars 6-7 of CLEE (chars 3-5 are the municipio). Use a NEW mat view `mv_scian_2digit` if the GROUP BY is too slow (likely fine — ~100 distinct values).

SCIAN names: hardcoded JSON `src/db/scian_2digit_names.json` (~20 entries, NOT fabricated — use the official INEGI taxonomy).

### `GET /tiles/:z/:x/:y.mvt?entidad=&sector=`

Auth: X-Api-Key. Returns Mapbox Vector Tile (binary protobuf) for the requested tile coordinates and filters.

Implementation: PostGIS `ST_AsMVT(...)` directly — no `pg_tileserv`, no new dependency. SQL:

```sql
WITH bounds AS (
  SELECT ST_TileEnvelope($z, $x, $y) AS geom
),
filtered AS (
  SELECT clee, nombre, clase_actividad, geom
  FROM establecimientos
  WHERE geom && (SELECT geom FROM bounds)
    AND ($entidad IS NULL OR entidad = $entidad)
    AND ($sector IS NULL OR SUBSTR(clee, 6, 2) = $sector)
),
mvt_geom AS (
  SELECT ST_AsMVTGeom(f.geom, b.geom, 4096, 64, true) AS geom,
         f.clee, f.nombre, f.clase_actividad
  FROM filtered f, bounds b
)
SELECT ST_AsMVT(mvt_geom, 'establecimientos') FROM mvt_geom;
```

Rate limiting: per-IP via Hono middleware (5 req/sec). Cache-Control: 1 hour.

**Hard cap**: 50k features per tile (use random sampling at the SQL layer if more). Avoids browser crash.

## Phased execution

### P-1 — README reconciliation (1 commit, 30 min)

Deliverables:

- Diff Jarvis's README claims vs reality (API endpoints, dependencies, demo numbers, mat view names)
- Rewrite affected sections to match `package.json`, `src/api/server.ts`, the actual DB
- Single commit `docs(readme): reconcile v0.1 claims with shipped reality`

Acceptance:

- `npm run typecheck && npm test` passes (no functional changes)
- README endpoint table matches `src/api/server.ts` route definitions exactly
- Validation section uses real numbers from `SELECT COUNT(*) FROM establecimientos GROUP BY entidad`
- Dependencies table matches `package.json` exactly

### P0 — Scaffold + walking skeleton (3 hours, 1 commit)

Deliverables:

- `web/package.json` with frozen-stack deps
- `web/vite.config.ts`, `tailwind.config.ts`, `tsconfig.json`
- `npm install` from inside `web/` succeeds
- `web/src/{main.tsx, App.tsx}` with router setup
- `ApiKeyGate` blocks the app until key is set in localStorage
- `Layout` with mode-toggle button (Map | Locust), both panels empty
- `npm run dev` from `web/` serves on port 5173, `npm run build` produces `dist/`

Acceptance:

- Operator can `cd web && npm install && npm run dev`, see API-key prompt, enter key, see toggle button switching between empty Map and Locust panels
- No 404 errors in console
- Single commit `feat(analyzer): P0 scaffold — Vite + React + router + API key gate`

### P1 — API additions (4-5 hours, 1 commit)

Deliverables:

- `src/api/handlers/entidades.ts` + tests
- `src/api/handlers/sectors.ts` + tests
- `src/api/handlers/tiles.ts` (the `ST_AsMVT` route) + tests
- Wire all 3 into `src/api/server.ts`
- `src/db/scian_2digit_names.json` with verified INEGI 2-digit SCIAN labels (cross-checked against https://www.inegi.org.mx/app/scian/ — DO NOT fabricate names)
- README endpoint table updated

Acceptance:

- `npm run typecheck && npm test` clean (existing 171 + ~15-20 new = ~190 tests)
- `curl -H "X-Api-Key: $K" http://localhost:3030/entidades | jq '.entidades | length'` returns 32
- `curl -H "X-Api-Key: $K" http://localhost:3030/sectors | jq '.sectors | length'` returns ~20 (one per 2-digit SCIAN)
- `curl -H "X-Api-Key: $K" "http://localhost:3030/tiles/12/1900/2300.mvt?entidad=09" | wc -c` returns >0 bytes
- Single commit `feat(api): tiles + entidades + sectors endpoints for analyzer frontend`

### P2 — Locust mode (6-8 hours, 1-2 commits)

Deliverables:

- `web/src/api/queries.ts` with TanStack Query hooks for `/entidades`, `/sectors`, `/summary/sector/:scian`, `/summary/entidad/:clave`, `/clusters`, `/search`
- `web/src/components/FilterPanel.tsx` — entidad + sector dropdowns synced to Zustand
- `web/src/modes/LocustMode.tsx` containing 3 ECharts:
  - Top 10 SCIAN sectors per selected entidad (horizontal bar)
  - Top 10 municipios per selected entidad (horizontal bar)
  - Estrato distribution per selected entidad (bar)
- Search bar at top — wire to `/search`, results in a list panel
- Click on a search result → opens `EstablishmentCard`
- Loading skeletons + error states (use TanStack Query `isLoading`/`isError`)
- Vitest frontend tests for the 3 ECharts containers (assertion: chart renders 10 series given mocked API response)

Acceptance:

- Operator can pick entidad=09 from dropdown → 3 charts populate within 2 sec
- Switching entidad re-fetches, no stale data shown
- Search "farmacia" returns results, click opens detail card
- Console errors: 0
- Single commit `feat(analyzer): P2 Locust mode — sector/municipio/estrato charts + search`

### P3 — Map mode (8-12 hours, 2-3 commits)

Sub-deliverables (commit per sub):

**P3a — Base map + filter sync**

- `web/src/modes/MapMode.tsx` with MapLibre at center=México (lat=23.6, lon=-102, zoom=5)
- Style toggle: Carto Positron / Dark Matter
- FilterPanel reuses Zustand state (entidad/sector) — selecting filters updates map source URL
- Commit: `feat(analyzer): P3a Map mode base — MapLibre + filter sync`

**P3b — Tile-based heatmap**

- MapLibre vector source pointing to `/tiles/:z/:x/:y.mvt?entidad=&sector=`
- deck.gl `HeatmapLayer` consuming the tile data
- Density renders smoothly on pan/zoom (60fps target)
- Commit: `feat(analyzer): P3b heatmap layer — deck.gl HeatmapLayer over MVT source`

**P3c — Click-to-detail + cluster overlay**

- Click on dense area → fires `/clusters?entidad=&sector=&k=10` → renders cluster centroids as larger circles
- Click on cluster centroid → list of member CLEEs in side panel (limited to 50 shown)
- Click on individual point → fetches `/establishment/:clee` → opens EstablishmentCard
- Commit: `feat(analyzer): P3c clusters + click-to-establishment`

Acceptance:

- Map loads at zoom 5 in <2 sec
- Pan/zoom maintains 60fps even at zoom 12 with 100k+ features visible (tiles handle the load)
- Filter changes update map within 1 sec
- Click on point opens detail card with full record
- Mobile breakpoint usable at 375px width

### P4 — Polish + deploy (3-4 hours, 1-2 commits)

Deliverables:

- Caddy block at `/etc/caddy/Caddyfile`:
  ```
  analyzer.denue.net {
    root * /var/www/denue-analyzer
    file_server
    try_files {path} /index.html
    handle_path /api/* {
      reverse_proxy localhost:3030
    }
  }
  ```
  **Note**: `handle_path` (not `handle`) is required so the `/api` prefix is stripped before proxying. This matches the Vite dev proxy behavior in `web/vite.config.ts` which also rewrites `/api/*` → `*`. Backend Hono routes are mounted at root (`/search`, `/health`, etc.), not under `/api`.
- `npm run build` from `web/` produces `dist/` → rsync to `/var/www/denue-analyzer`
- DNS A record for `analyzer.denue.net` → VPS IP (operator-side, may need manual)
- Caddy reload + verify TLS via Let's Encrypt
- README screenshots + Quickstart section update
- Commit: `feat(deploy): P4 analyzer live at analyzer.denue.net + README polish`

Acceptance:

- `https://analyzer.denue.net` serves the built app over HTTPS
- API calls from browser go via `/api/*` to localhost:3030 (no CORS issue, no exposed `:3030` publicly)
- Lighthouse score: Performance ≥80, Accessibility ≥90 on a desktop test
- Single commit per the deploy

## Hard constraints (apply to every phase)

1. **No new dependencies beyond the frozen stack.** If something is needed, STOP, confirm with operator, then update this plan.
2. **All API responses validated with Zod at the client boundary.** Defense in depth — even our own API can drift.
3. **No live HTTP in tests.** Mock fetch with vi.stubGlobal everywhere, like Phase 5.
4. **Tmux for any `npm install` / `npm run build` / dev server runs.** Per the directive deployed for Jarvis — applies to me too on 60s+ commands. Pattern:
   ```
   tmux new-session -d -s analyzer-build "cd web && npm install 2>&1 | tee /tmp/analyzer-install.log"
   ```
5. **Backend changes ship with tests in the same commit.** Mirror the today's audit-then-fix pattern.
6. **Per-phase audit cycle.** After each phase: spawn `qa-auditor` agent on changed files, fix Critical findings before moving to next phase.
7. **Reuse existing patterns**:
   - HttpError class from `src/api/middleware/error.ts`
   - Validation regex from `src/api/types.ts` (ENTIDAD_RE, SCIAN_RE, CLEE_RE)
   - INEGI counts JSON loader from `src/analysis/coverage-report.ts`
   - Cluster runner from `src/analysis/cluster-by-sector.ts`
8. **Pipeline write-path is sacred.** Don't touch `src/extractor/`, `src/db/loader.ts`, `src/pipeline/`, `scripts/pipeline.ts` unless explicitly required. The 6.1M dataset took 8h to load — preserve that.

## Out of scope (do NOT build in v1.0)

- AGEB polygons / NSE choropleths — wait for Jarvis's Phase 1 (Censo+CONEVAL)
- Pobreza overlays — same dependency
- Time series — DENUE has no historical
- SINAIS / Datatur / ENOE / ENIGH layers — separate Jarvis phases
- User authentication beyond single API key
- Multi-tenant routing
- Mobile-first responsive design (just usable at 375px)
- Internationalization
- Server-side rendering / Next.js
- Analytics, telemetry, A/B testing
- Export to PDF / image

## Risks + mitigations

| Risk                                     | Mitigation                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `ST_AsMVT` complexity blows up timeline  | Fallback: client-side rendering with sample cap of 5k points/query in P3b. Lose 60fps but ship.  |
| Vite build slow on VPS                   | Build locally + rsync. Or use the tmux pattern for unattended builds.                            |
| MapLibre + deck.gl version compatibility | Lock both to versions verified in deck.gl docs at start of P3. Pin in package.json.              |
| Frontend cost spike during dev           | Each phase ships before moving on — operator can pause anytime.                                  |
| Compaction loses my context mid-phase    | This plan is the contract. On resume, read it + commit log + run typecheck/tests, then continue. |

## What I (Claude) will do at next session start

If the next session opens with this plan in scope and the work is partial:

1. `cat docs/analyzer-plan-v1.md` to re-orient
2. `git log --oneline -10` to see what shipped
3. `npm run typecheck && npm test` to verify state
4. Find the most recent acceptance criteria not yet met → resume from there
5. Don't re-deliberate sealed decisions; execute

## Sign-off

Plan version: 1.0
Decisions sealed: 8/8
Phases: 5 (P-1, P0, P1, P2, P3, P4)
Total estimated effort: 25–35 hours = 3–5 focused sessions
First action on green-light: P-1 README reconciliation (30 min)

If operator says "go" → start with P-1.
If operator says "/compact" → write nothing else; resume from this doc next session.
