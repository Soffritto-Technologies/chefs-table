/**
 * Shared contract for Chef's Table. Every module codes against these shapes.
 * This file has no runtime logic beyond constants; change it only on purpose,
 * because model, diff, anchors, session and render all depend on it.
 *
 *   journeys.json (JourneysDoc)            plan.json (Plan)
 *          │                                     │
 *          ▼                                     ▼
 *   model.validate/sanitize ──► diff.diffDocs / diff.findConflicts ──► render.buildViewModel ──► render.renderHtml
 *                                     ▲                                    ▲
 *                     anchors.checkAnchors (AnchorState per step) ─────────┘
 */

/**
 * @typedef {{ type: 'file' | 'route', value: string }} Anchor
 * Where a step lives in code. `file` is a repo-relative path; `route` is a URL path like "/checkout".
 */

/**
 * @typedef {object} StepDetail
 * Plain-language detail shown on the L3 step card. Every field is optional.
 * @property {string} [sees]     What the user sees.
 * @property {string} [does]     What the user does.
 * @property {string[]} [rules]  Business rules and decisions, e.g. "Card declined → error stays on page".
 * @property {string[]} [saves]  Data the step stores, e.g. "Order".
 * @property {string[]} [files]  Repo-relative source files involved.
 */

/**
 * @typedef {object} Step
 * @property {string} id                 Unique within its journey.
 * @property {string} [label]          Short label shown on the map: 2–6 words, verb first, ≤48 chars (e.g. "Allow Gmail access").
 * @property {string} say                One plain sentence, shown in the step card and on hover, ≤200 chars.
 * @property {string|null} screen        URL path the user sees, or null (e.g. an email).
 * @property {Anchor} anchor
 * @property {Array<string | StepNext>} next  Following steps in the same journey: an id, or { to, when } with the condition.
 * @property {'action' | 'decision' | 'outcome' | 'background'} [kind]  Default 'action'. Decisions branch on conditions; outcomes end a path.
 * @property {'success' | 'failure' | 'abandoned'} [result]  Outcome steps only: how the path ends for the person.
 * @property {string} [continues]      Id of another journey this step hands over to (e.g. checkout continues in "pay").
 * @property {string} [trigger]        Background steps: what starts it, ≤60 chars (e.g. "Every hour", "When a message arrives").
 * @property {StepDetail} [detail]
 * @property {string} [subflow]          Id of another journey that zooms in on this step.
 */

/**
 * @typedef {object} StepNext
 * @property {string} to                 Step id in the same journey.
 * @property {string} [when]            Condition in plain words, ≤40 chars (e.g. "Code sent", "Card declined").
 */

/**
 * @typedef {object} Journey
 * @property {string} id                 Unique across the document.
 * @property {string} title              ≤200 chars.
 * @property {string} [area]             Area id; journeys without one go to the "other" area.
 * @property {string} [who]              Who performs the journey, e.g. "Customer".
 * @property {string[]} [apps]          Ids of the apps it happens in (see JourneysDoc.apps), e.g. ["desktop"].
 * @property {Step[]} steps
 */

/**
 * @typedef {object} Area
 * @property {string} id
 * @property {string} title
 * @property {string} [say]
 * @property {string} [parent]          Id of the area this one sits inside (a section). Top-level areas have none. At most 4 levels deep.
 */

/**
 * @typedef {object} App
 * One app in the repo. Journeys are tagged with app ids so the map can show where each happens.
 * @property {string} id                 Lowercase-hyphen, e.g. "frontend", "desktop", "backend".
 * @property {string} title              Plain name, e.g. "Web app", "Mac app", "Background".
 * @property {'web' | 'desktop' | 'mobile' | 'server' | 'agent'} kind
 * @property {string} root               Repo-relative folder of the app ("." for a single-app project).
 */

/**
 * @typedef {object} JourneysDoc
 * Contents of .journeys/journeys.json.
 * @property {1} version
 * @property {string} app
 * @property {App[]} [apps]            The apps this repo ships (absent for single-app projects).
 * @property {Area[]} [areas]
 * @property {Journey[]} journeys
 */

/**
 * @typedef {object} Plan
 * Contents of .journeys/.session/<sid>/plan.json.
 * @property {string} summary            One plain-language line shown to the builder.
 * @property {Journey[]} upsert          Whole journeys to add or replace (by id).
 * @property {string[]} remove           Journey ids to remove.
 * @property {string[]} [touches]        Screens whose code the plan will change.
 */

/**
 * @typedef {object} Config
 * Contents of .journeys/config.json, merged over DEFAULT_CONFIG.
 * @property {string} root               App root relative to the repo root.
 * @property {string[]} sourceGlobs      Where route definitions may live.
 * @property {string[]} routeDirs        File-system router directories.
 * @property {string[]} ignore           Globs never treated as flow code.
 * @property {string[]} shared           Screens every journey passes through.
 */

/** @typedef {'stable' | 'new' | 'changed' | 'removed'} ChangeState */
/** @typedef {'ok' | 'broken' | 'unverified'} AnchorState */
/** @typedef {'auto' | 'approved' | 'unconfirmed' | 'pending'} ApprovalState */

/**
 * @typedef {object} Conflict
 * @property {string} screen             The shared screen.
 * @property {string} planJourney        Journey id in the plan that changes the screen.
 * @property {string[]} otherJourneys    Journeys outside the plan that use the screen.
 * @property {'add' | 'change' | 'remove' | 'touches'} kind
 */

/**
 * @typedef {object} ViewNode
 * One node of the zoomable tree. The template draws one node and its children at a time.
 * @property {'app' | 'area' | 'journey' | 'step'} kind
 * @property {string} id                 For steps: "<journeyId>/<stepId>".
 * @property {string} title
 * @property {string} [say]            Areas/journeys: description. Steps: the full sentence (card and hover).
 * @property {boolean} [derivedLabel]  Steps only: true when the title was derived from `say` because the step had no label.
 * @property {ChangeState} state         Compared with the chat's start (session) or 'stable' (canonical).
 * @property {boolean} latest            Changed in the latest turn (thicker ring).
 * @property {boolean} planned           Part of the pending plan (ghost overlay).
 * @property {string[]} flags            Any of FLAGS.
 * @property {AnchorState} [anchor]      Steps only.
 * @property {Rollup} rollup             Strongest state of this node and everything inside it.
 * @property {ViewNode[]} children       app→top-level areas; area→its sections (areas) first, then its own journeys; journey→steps; step→[].
 * @property {'ring' | 'grid'} [layout]   App and areas only: 'grid' when a level has more than 24 items, else 'ring'.
 * @property {Record<string, 'ring' | 'grid'>} [layouts]  App and areas only: the layout per app filter (multi-app maps).
 * @property {string[]} [apps]          Journeys only: app ids the journey happens in.
 * @property {Array<[string, string] | [string, string, string]>} [edges]  Journeys only: [from, to] or [from, to, when].
 * @property {'action' | 'decision' | 'outcome' | 'background'} [stepKind]  Steps only.
 * @property {'success' | 'failure' | 'abandoned'} [result]  Outcome steps only.
 * @property {string} [trigger]        Background steps only.
 * @property {string} [continues]      Steps only: journey id the flow carries on in.
 * @property {string[]} [ruleChips]    Steps only: up to 2 short rules shown on the canvas.
 * @property {number} [moreRules]      Steps only: rules not shown as chips.
 * @property {number} [findingCount]   Findings on this node and beneath it.
 * @property {'high' | 'medium' | 'low'} [findingSeverity]  Strongest finding severity on or beneath this node.
 * @property {number} [depth]            Steps only: column index along `next`.
 * @property {StepDetail} [detail]       Steps only.
 * @property {string|null} [screen]      Steps only.
 * @property {string} [subflow]          Steps only: journey id to zoom into.
 */

/** @typedef {'conflict' | 'changed' | 'new' | 'broken' | 'stable'} Rollup */

/**
 * @typedef {object} ViewModel
 * Everything the template needs; it computes nothing itself.
 * @property {'canonical' | 'session'} mode
 * @property {string} app
 * @property {Array<{ id: string, title: string, kind: string }>} [apps]  Apps in the repo (multi-app maps); drives badges and the filter.
 * @property {Finding[]} [findings]     Health-check results shown in the Findings layer.
 * @property {ViewNode} root
 * @property {Record<string, ViewNode>} journeys  Every journey node by id, including sub-flow-only journeys.
 * @property {string[]} banners          e.g. "Planned, not built yet: Add call booking".
 * @property {string[]} chips            e.g. "Share link out of date", "Map tool error".
 * @property {string} [planSummary]
 * @property {ApprovalState} [approval]
 */

/**
 * @typedef {object} DiffResult
 * Output of diff.diffDocs(base, current). Keys: "j:<journeyId>" and "s:<journeyId>/<stepId>".
 * Keys missing from `states` are 'stable'.
 * @property {Record<string, ChangeState>} states
 * @property {Journey[]} removedJourneys                       Present in base only (drawn faded).
 * @property {Array<{ journeyId: string, step: Step }>} removedSteps  Steps removed from journeys that still exist.
 */

/**
 * @typedef {object} RenderInput
 * Input of render.buildViewModel. Session-only fields are ignored in canonical mode.
 * @property {'canonical' | 'session'} mode
 * @property {JourneysDoc} doc            Current document (with the pending plan applied for the overlay, if any).
 * @property {DiffResult} [sinceStart]    diffDocs(start, doc): colours for the whole chat.
 * @property {DiffResult} [sinceLast]     diffDocs(last, doc): latest-turn ring.
 * @property {Set<string>} [plannedKeys]  "j:"/"s:" keys changed by the pending plan (ghost overlay).
 * @property {Conflict[]} [conflicts]
 * @property {Record<string, AnchorState>} [anchors]  By "s:<journeyId>/<stepId>".
 * @property {Record<string, string[]>} [flags]       Extra FLAGS by "j:"/"s:" key.
 * @property {Finding[]} [findings]          Health-check results (journeys health) shown as a layer; targets that no longer exist are ignored.
 * @property {string[]} [banners]
 * @property {string[]} [chips]
 * @property {string} [planSummary]
 * @property {ApprovalState} [approval]
 */

/* ───────────── First-map pipeline: chop (no AI) → stir (AI units) → check (coverage) → plate ───────────── */

/**
 * @typedef {object} InventoryPage
 * A screen a user can reach.
 * @property {string} route              Normalized route, e.g. "/checkout" or "/blog/:param".
 * @property {string} file               Repo-relative file that renders or defines it.
 * @property {'next' | 'router'} source  Next.js file route, or a router definition (path: / <Route path>).
 * @property {string} area               Area id it was grouped into (first URL segment, or "home" for "/").
 * @property {string} [app]              App id (multi-app repos).
 */

/**
 * @typedef {object} InventoryItem
 * Something a user can touch or that happens to them, found without AI.
 * @property {'form' | 'api-call' | 'endpoint' | 'auth-guard' | 'email' | 'job' | 'model' | 'window' | 'menu' | 'ipc'} kind
 * @property {string} [app]              App id the file belongs to (multi-app repos).
 * @property {string} file               Repo-relative path.
 * @property {number} line               1-based line of the first match.
 * @property {string} detail             Short evidence, e.g. "POST /api/pay" or "model Order", ≤120 chars.
 */

/**
 * @typedef {object} Inventory
 * Contents of .journeys/inventory.json. Deterministic: same code → identical file.
 * @property {1} version
 * @property {App[]} [apps]            Apps found by the app finder (multi-app repos).
 * @property {Array<{ app: string, key: string, title: string, files: string[] }>} [features]
 *           Code users notice that no page reaches (desktop windows, background agents, server emails/jobs), grouped by feature folder.
 * @property {string|null} head          Git HEAD commit when built (read from .git without the git binary), or null.
 * @property {InventoryPage[]} pages
 * @property {Array<{ from: string, to: string }>} links   Source file → normalized route it links/navigates to.
 * @property {InventoryItem[]} items
 * @property {Record<string, string[]>} imports            File → repo-relative files it imports (relative and '@/' alias only).
 * @property {Array<{ id: string, title: string, routes: string[] }>} areas
 * @property {Record<string, { bytes: number, sha1: string }>} files   Every scanned source file.
 */

/**
 * @typedef {object} WorkUnit
 * One chunk of the codebase small enough for a single AI helper.
 * @property {string} id                 Stable id, e.g. "area-shop", "area-shop-2" or "gap-1".
 * @property {'area' | 'gap' | 'refresh' | 'feature' | 'polish'} kind
 * @property {string} [app]              App id the unit belongs to.
 * @property {string} area
 * @property {string} title              Plain-language label, e.g. "Shop (part 2 of 3)".
 * @property {string[]} routes           Pages this unit must cover.
 * @property {string[]} files            Files the helper should read, most important first.
 * @property {number} estTokens          Rough size of `files` (bytes / 4).
 */

/**
 * @typedef {object} Coverage
 * How much of the inventory the map explains.
 * @property {{ covered: number, total: number, missing: string[] }} pages      Missing = routes.
 * @property {{ covered: number, total: number, missing: string[] }} forms      Missing = files.
 * @property {{ covered: number, total: number, missing: string[] }} endpoints  Missing = "file: detail".
 * @property {{ covered: number, total: number, missing: string[] }} [features] Missing = "app/key". A feature is covered when any of its files is a step anchor or in detail.files.
 * @property {number} percent            pages.covered / pages.total × 100, rounded (100 when there are no pages).
 */

/**
 * @typedef {object} MapJob
 * Contents of .journeys/build/job.json: a resumable first-map (or sync) run.
 * @property {1} version
 * @property {'first-map' | 'sync'} kind
 * @property {'stir' | 'check' | 'stopped' | 'done'} phase
 * @property {{ tokens: number|null, percent: number|null, startPercent: number|null, lastPercent: number|null }} budget
 * @property {number} usedTokens         Tokens metered from AI helpers working on this job.
 * @property {Array<WorkUnit & { status: 'pending' | 'in_progress' | 'done' | 'failed', tokens: number, attempts: number }>} units
 * @property {string|null} stopReason    Plain-language reason when phase is 'stopped'.
 */

/**
 * @typedef {object} Finding
 * One health-check result (no AI), stored in .journeys/findings.json and shown as a layer on the map.
 * @property {string} id                 Stable: "<check>:<target>".
 * @property {'dead-end' | 'no-recovery' | 'no-success' | 'unreachable' | 'rules-disagree' | 'orphan-page' | 'orphan-feature' | 'complex-journey' | 'shared-hotspot' | 'logic-heavy'} check
 * @property {'high' | 'medium' | 'low'} severity
 * @property {string} target             "j:<journeyId>", "s:<journeyId>/<stepId>", "page:<route>", "feature:<app>/<key>" or "file:<path>".
 * @property {string} message            Plain language, ≤160 chars.
 * @property {string[]} [evidence]      Files, steps or rules that show it.
 */

export const PIPELINE = Object.freeze({
  UNIT_MAX_TOKENS: 40000,
  COVERAGE_TARGET: 95,
  UNIT_MARKER: '[chefs-table unit ',
});

export const FLAGS = Object.freeze({
  CONFLICT: 'conflict',
  UNCONFIRMED: 'unconfirmed',
  TWO_CHATS: 'two-chats',
  CODE_TOUCHED: 'code-touched',
  UNMAPPED: 'unmapped',
});

/** Rollup precedence, strongest first. */
export const ROLLUP_ORDER = Object.freeze(['conflict', 'changed', 'new', 'broken', 'stable']);

export const OTHER_AREA_ID = 'other';

export const LIMITS = Object.freeze({ TEXT: 200, LABEL: 48, INJECT_BYTES: 2048 });

/** @type {Config} */
export const DEFAULT_CONFIG = Object.freeze({
  root: '.',
  sourceGlobs: ['src/**', 'app/**', 'pages/**'],
  routeDirs: ['app', 'pages', 'src/app', 'src/pages', 'src/routes'],
  ignore: ['**/node_modules/**', '**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/*.md', '**/*.lock', 'package-lock.json', 'pnpm-lock.yaml', '.github/**', '.journeys/**'],
  shared: ['/', '/dashboard'],
});
