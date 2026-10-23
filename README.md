# journeymap

**A live, zoomable map of your app's user journeys that Claude Code keeps up to date as it builds.**

Not everyone building an app with AI can read the code. journeymap gives you a picture instead:

- **Your whole app at a glance.** Areas (Buying, Booking, Accounts…) sit in a ring. Double-click to zoom into an area's journeys, a journey's steps, a step's detail, and any step's own sub-flow, as deep as you need.
- **See changes before they're built.** When Claude plans something you'd notice, it draws the change on the map first: new journeys dashed, changing ones amber, clashes with existing flows in red. If a change would build over an existing journey, Claude Code asks you before editing any code.
- **See what this chat changed.** Everything added or changed since the chat started stays highlighted, and the last turn's changes get a thicker ring.
- **Stays honest.** Every step is tied to real code. Steps whose page disappeared show a warning. A new page that nobody put on the map shows up as "Unmapped changes".

It's a plugin for [Claude Code](https://claude.com/claude-code): a skill and four small hooks. Node.js is the only thing it needs.

## Install

```bash
claude plugin marketplace add bmoski8/journeymap && claude plugin install journeymap@journeymap
```

Or from inside Claude Code:

```
/plugin marketplace add bmoski8/journeymap
/plugin install journeymap@journeymap
```

Then open your project in Claude Code and run:

```
/journeymap:map-app
```

Claude surveys your app, draws the first map, publishes it as a private link you can open and share, and asks you to correct anything that's wrong. From then on the map updates itself as you build.

**Needs:** Claude Code and Node.js 20+ ([nodejs.org](https://nodejs.org)).

## How it works

```
you ask for a change ─► Claude writes the plan on the map ─► you see the proposal (ghost overlay)
                                                     │
                     clashes with an existing journey? ─► Claude Code asks you before any edit
                                                     ▼
                         Claude builds ─► end of turn: map checked against the code, redrawn, republished
```

- **`.journeys/journeys.json`** is the map's data: areas, journeys, steps, each tied to a file or route. Claude writes it in plain language. You never have to.
- **`journeys.html`** is a clean, self-contained copy of the map that you commit with your code. It opens offline and has no external requests.
- **`.journeys/.session/`** (gitignored) holds each chat's view, with its change colours and proposals. Parallel chats don't collide.

The hooks are fast (under 100ms per edit), never block a turn more than once, and never break your session if something goes wrong.

### Settings

`.journeys/config.json` (committed):

| Key | Default | What it does |
|---|---|---|
| `shared` | `["/", "/dashboard"]` | Screens every journey passes through. Adding a step there isn't treated as a clash. |
| `routeDirs` | `app`, `pages`, `src/app`, `src/pages`, `src/routes` | Where file-based routes live (Next.js style). |
| `sourceGlobs` | `src/**`, `app/**`, `pages/**` | Where to look for route definitions (React Router, Vite and others). |
| `ignore` | tests, docs, lockfiles… | Files that never count as flow changes. |

Environment variable `JOURNEYMAP_GATE`:
- `on` (default): ask before risky edits.
- `warn`: build anyway, and mark the change "built without approval" on the map.
- `off`: no gate. Use `warn` or `off` for headless and CI runs, where nobody can answer a prompt.

## Status

Early (v0.1). Route checking understands Next.js file routes and `path:` / `<Route path>` definitions. Other frameworks show as "unverified" rather than wrong. See [TODOS.md](TODOS.md) for what's next.

## Contributing

Small, focused pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately: [SECURITY.md](SECURITY.md).

MIT licensed.
