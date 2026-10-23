# Architecture

Chef's Table is a Claude Code plugin made of four parts:

- a skill (`skills/chefs-table/SKILL.md`)
- a slash command (`commands/map-app.md`)
- four hooks (`hooks/hooks.json`)
- a zero-dependency Node CLI (`bin/journeys.mjs`)

## Data

```
<project>/
├── journeys.html                    committed · clean map (no change colours, no proposals)
└── .journeys/
    ├── journeys.json                committed · source of truth (see lib/types.mjs)
    ├── config.json                  committed · shared screens, route dirs, globs
    ├── .local.json                  gitignored · this person's share link
    └── .session/<session_id>/       gitignored · one folder per chat, swept after 7 days
        start.json  last.json  routes.json  touched.json  plan.json  approval.json
        view.html   view.hash  published    anchor-cache.json  flags.json  turn.json  errors.log
```

`journeys.json` holds areas, then journeys, then steps.
- **Anchors.** Every step has an anchor tying it to code: a `file` path, or a `route` like `/checkout`.
- **Detail.** Steps can carry `detail` (what the user sees and does, rules, data saved, files).
- **Sub-flows.** Steps can carry a `subflow` pointing at another journey that zooms in on them.
- **Derived, not stored.** States like new, changed or conflict are never stored. They're computed by diffing snapshots.

## Zoom levels

```
App ─ ring of areas ─► Area ─ ring of journeys ─► Journey ─ step flow ─► Step ─ detail card
                                                        ▲                       │ subflow
                                                        └──── same flow view ◄──┘  (any depth)
```

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
Stop          apply plan (check-then-save) → diff → anchors → conflicts → drift → render → maybe block once
```

## Stop policy

| Pass | Situation | Action |
|---|---|---|
| 1 | `journeys.json` invalid | Block: fix the JSON |
| 1 | Unmapped change: a new page nobody mapped, or a mapped file edited while its journey didn't change | Block: map it, or write `no-flow-change` with a reason |
| 1 | Plan approved, auto or unconfirmed, and code was edited | Apply the plan to `journeys.json` and delete `plan.json` |
| 1 | Plan pending and not approved | No block. Keep the overlay. Don't advance. |
| 1 | Share link set but the published map is out of date | Block: republish |
| 1 | Several of the above | **One** block that lists them all |
| 2 (`stop_hook_active`) | Anything | Never block. Show leftovers on the map as chips. |

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
| `lib/render.mjs` | View-model tree and HTML rendering (escaped) |
| `bin/journeys.mjs` | CLI and hook dispatcher |
