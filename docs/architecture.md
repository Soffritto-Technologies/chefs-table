# Architecture

Chef's Table is a Claude Code plugin made of five parts:

- a skill (`skills/chefs-table/SKILL.md`)
- four slash commands (`commands/`)
  - `map-app.md`: draw (or resume) the map of the whole app inside a budget
  - `sync.md`: refresh the map after code changed outside a chat, redoing only what's stale
  - `order.md`: work out what follows what in an existing map
  - `share.md`: publish the map as it is now to the project's share link
- five hooks (`hooks/hooks.json`: SessionStart, PreToolUse, PostToolUse, SubagentStop, Stop), all run through `bin/run.sh`
- a helper agent (`agents/mapper.md`) that runs the AI work units
- a zero-dependency Node CLI (`bin/journeys.mjs`)

## Data

```
<project>/
├── journeys.html                    committed · clean map (no change colours, no proposals)
└── .journeys/
    ├── journeys.json                committed · source of truth (see lib/types.mjs)
    ├── config.json                  committed · shared screens, route dirs, globs
    ├── .local.json                  gitignored · this person's share link
    ├── inventory.json               committed · the chop (no-AI) inventory, baseline for sync
    ├── aliases.json                 committed · old journey id → merged journey id (from polish)
    ├── findings.json                committed · health findings (from `journeys health`)
    ├── .anchor-cache.json           gitignored · route/file scan shared by every chat
    ├── build/                       gitignored · resumable map/sync/polish job, unit briefs and outputs
    └── .session/<session_id>/       gitignored · one folder per chat, swept after 7 days
        start.json  last.json  routes.json  touched.json  step-files.json  plan.json  approval.json
        view.html   view.hash  view-stamp.js  published  notable.json  flags.json  turn.json
        no-flow-change  errors.log
```

`journeys.json` holds areas, then journeys, then steps.
- **Anchors.** Every step has an anchor tying it to code: a `file` path, or a `route` like `/checkout`.
- **Detail.** Steps can carry `detail` (what the user sees and does, rules, data saved, files).
- **Sub-flows.** Steps can carry a `subflow` pointing at another journey that zooms in on them.
- **Derived, not stored.** States like new, changed or conflict are never stored. They're computed by diffing snapshots.

## First map: chop → stir → check → organise → order → polish → health → plate

`/chefs-table:map-app` runs these stages (after finding the apps and setting the stopper). `/chefs-table:sync` reuses them: `journeys sync` re-scans, diffs against the saved `inventory.json` and queues units only for new or changed journeys. Then it runs stir to plate, skipping organise and order unless journeys were added, and polishing only the touched areas.

- **find the apps** (no AI, `lib/apps.mjs`): `journeys apps` lists the apps a repo ships (web, desktop, mobile, server, agent) from workspace settings and package files. The builder picks which to map (`--apps`); journeys are tagged with their app.
- **stopper**: the budget is `--budget-percent` of the 5-hour window when usage can be read, else `--budget-tokens`. Checked before every wave.
- **chop** (no AI): inventory of pages, links, forms, endpoints; work units sized for one helper (big single pages split by feature folder).
  - **Facts scan** (`lib/facts.mjs`, no AI): when the project has a TypeScript compiler installed, each JS/TS file becomes a short summary (on-screen words, buttons and where they lead, data calls, show-only-when conditions, state changes), about a fifteenth of the code. Units are then sized by summary (`FACTS_UNIT_MAX_TOKENS`), briefs carry the summaries, and labelled buttons become `action` items. Summaries live in `build/facts.json`. No compiler, or `CHEFS_TABLE_FACTS=off`: helpers read whole files as before.
- **stir**: one helper per unit writes journeys; metered from SubagentStop transcripts; stops at the budget and resumes later. Helpers run as the plugin's `mapper` agent (Read, Write, Bash, Glob, Grep only), so each starts without the session's other tools.
- **check** (no AI): merge units, coverage; gap units for missing pages.
- **organise**: one helper regroups the whole map into ≤8 areas with sections, real roles, same-goal variants side by side.
- **order** (`lib/order.mjs`): one cheap helper (haiku, reads titles only) says what follows what, as `next` on areas and journeys.
- **polish**: one helper per area merges same-goal variants into one journey with branches and writes short step labels; rejected if any code anchor is lost.
- **health** (no AI, `lib/health.mjs`): flags dead ends, journeys with no ending, steps nothing leads to, unmapped pages and the like. Writes `findings.json`; the map shows them as a layer.
- **plate**: render and publish.

## Zoom levels

```
App ─ flow of areas ─► Area ─ flow of sections and journeys ─► Journey ─ flow of steps ─► Step ─ detail card
                                                                    ▲                          │ subflow
                                                                    └────── same flow view ◄───┘  (any depth)
```

Every level is a flow, never a mind map: boxes in columns, left to right, with labelled arrows. Steps follow `Step.next`. Areas and journeys follow `Area.next`, `Journey.next` and steps' `continues`, lifted onto whichever box holds them (`lib/order.mjs`). Parts marked `anytime` (settings, help) sit in their own "Any time" column. A level with no known order gets a guess from names, drawn with dotted arrows and labelled as a guess until the order pass (`/chefs-table:order`) fills it in.

`lib/render.mjs` turns the document into one view-model tree. `templates/journeys.html` only draws it, one level at a time. Each node's colour is the strongest state of everything inside it, so a change deep in the app lights up its path from the top.

## Per-turn flow

```
SessionStart  create .session/<id>/ (resume/compact keep the chat's baseline) · inject journey list as data
plan          Claude writes plan.json → `journeys plan` → ghost overlay → MAP_CHANGED → Claude republishes
PreToolUse    plan needs approval?  GATE=on → permissionDecision "ask" (Claude Code's own prompt)
                                    GATE=warn → allow, mark "unconfirmed" · GATE=off → nothing
              no plan, editing a mapped file → one non-blocking reminder (additionalContext)
PostToolUse   edit → record touched file; first edit while approval pending → approved (default mode) / unconfirmed
              Artifact publish of view.html → remember share link + published hash
SubagentStop  map-job helper finished → count its transcript tokens toward the budget, once per helper (only while stirring, or just after `organise brief`)
Stop          apply plan (check-then-save) → diff → anchors → conflicts → drift → render → important news (systemMessage) → maybe block once
```

## Stop policy

| Pass | Situation | Action |
|---|---|---|
| 1 | `journeys.json` invalid | Block: fix the JSON |
| 1 | Unmapped change: a new page nobody mapped, or a mapped file edited while its journey didn't change | Block: map it, or write `no-flow-change` with a reason |
| 1 | Plan approved, auto or unconfirmed, and code was edited | Apply the plan to `journeys.json` and delete `plan.json` |
| 1 | Plan pending and not approved | No block. Keep the overlay. Don't advance. |
| 1 | Share link set, published map out of date, `share: every-change` | Block: republish |
| 1 | Share link set, published map out of date, `share: on-request` (default), and any of: something important is new, HEAD moved since the link was last published (in any chat), another block is happening anyway | Block (or join that block): republish |
| 1, 2 | Share link out of date, nothing important new (or pass 2) | No block. Chip "Share link updates at the next commit" on the map. |
| 1, 2 | Something important is new (default mode) | `systemMessage` one-line notice in chat (no model call), alongside any block |
| 1 | Several of the above | **One** block that lists them all |
| 2 (`stop_hook_active`) | Anything | Never block. Show leftovers on the map as chips. |

**Important** (`lib/notable.mjs`), reported once per chat via `notable.json`, which keeps only the keys still present, so an item that is fixed and returns is reported again:
- a plan waiting for approval, and any clash it has with existing journeys
- a step built without approval (`unconfirmed`) or edited in two chats
- a step of the saved map whose anchor is `broken`
- a high-severity health finding (low ones such as `unmapped-action` never count)
- a journey added to or removed from the saved map (not wording or colour changes)

HEAD is read from `.git` files only by `lib/git.mjs` (loose ref, then `packed-refs`; detached HEAD; `.git` files and `commondir` for worktrees), never by running git. The PostToolUse publish hook stores it as `publishedCommit` in `.local.json`, next to the link; an unreadable repository counts as unknown and never triggers. The link and `publishedCommit` are per project, so a new chat catches up only if a commit landed since the last publish anywhere; uncommitted work from an earlier chat waits for the next commit.

The chip is added after the first render, so the hash compared with the published one (`view.hash`) never contains it. `journeys share` (used by `/chefs-table:share`) redraws without chips before publishing.

**Live map.** `renderSession` embeds a render id (sha1 of the view model; no timestamps) as `live.id` and writes `view-stamp.js` next to `view.html` with the same id. Only the per-chat view carries `live`. On a `file:` copy, the template adds a `<script src="view-stamp.js?t=…">` every 3 s (paused while the tab is hidden) and reloads when the id differs; the level stays in `location.hash`, and zoom, pan and scroll are kept in `sessionStorage`. The saved `journeys.html`, `docs/sample.html` and the published copy never poll.

Hooks never fail a session. Errors go to `errors.log` and show as a chip on the map.

## Definitions

- **Conflict:** a plan adds, changes or removes a step on screen S (or lists S in `touches`) while S is used by a journey the plan doesn't include.
  - On a `shared` screen, only changing or removing an existing step counts. Adding a step there doesn't.
- **Needs approval:** any conflict, or more than one journey changed at once.
- **Anchor states:**
  - `ok`
  - `broken`: the file is missing, or the route is missing in a Next.js app
  - `unverified`: the route is only mentioned, or the framework isn't understood. This is never treated as broken.
- **Approval:** comes only from Claude Code's own permission prompt. It is recorded as `approved` only in the default permission mode. Any other mode records `unconfirmed`, which shows as a red badge.

## Modules

| File | Role |
|---|---|
| `lib/types.mjs` | Shared contract (typedefs, defaults) |
| `lib/model.mjs` | Load, validate, sanitize, apply plans, check-then-save |
| `lib/diff.mjs` | Change states, conflicts, approval rule, rollup |
| `lib/anchors.mjs` | Route and file checks (Next.js file routes, `path:` / `<Route path>` definitions), cached |
| `lib/glob.mjs` | Small glob matcher and file walker |
| `lib/session.mjs` | Per-chat state, atomic writes, cleanup |
| `lib/git.mjs` | Current commit read from `.git` files (no git process) |
| `lib/notable.mjs` | Important-news items (stable keys) and the one-line chat notice |
| `lib/render.mjs` | View-model tree and HTML rendering (escaped) |
| `lib/facts.mjs` | Facts scan: per-file summaries with the project's own TypeScript compiler (map runs only) |
| `lib/apps.mjs` | Find the apps a repo ships, and tag files and journeys with them |
| `lib/inventory.mjs` | Chop: no-AI scan of pages, links, forms, endpoints; sizes the work units |
| `lib/mapjob.mjs` | Resumable map/sync/polish job: units, budget, merging helper output, rebase, aliases |
| `lib/order.mjs` | Order of areas, journeys and steps (`next`, `continues`, "Any time" parts) |
| `lib/health.mjs` | No-AI health findings, stored in `findings.json` |
| `lib/util.mjs` | Sorted-key JSON, atomic writes, sha1 |
| `bin/journeys.mjs` | CLI and hook dispatcher |
| `bin/run.sh` | Hook launcher: checks for Node 20+, never breaks the session |
| `templates/journeys.html` | The map page; draws the view model one level at a time |
| `agents/mapper.md` | Helper agent for map units (Read, Write, Bash, Glob, Grep only) |
