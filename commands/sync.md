---
description: Refresh the journey map after code changed outside a chat (teammates, git pull), redoing only what's stale
argument-hint: "[budget, e.g. 5% of 5-hour usage, or 500k tokens]"
---

Bring the journey map back in line with the code, redoing only the journeys whose code changed.

CLI: `node "${CLAUDE_PLUGIN_ROOT}/bin/journeys.mjs"` (written below as `journeys`).

1. **Set the stopper** exactly as in `/chefs-table:map-app` step 1. The budget comes from: $ARGUMENTS. If none is given, the default is 5 percentage points of the 5-hour window, or 500000 tokens.
2. **Run `journeys sync`** with those budget flags.
   - `SYNC_NOTHING`: tell the builder the map is already current, and stop.
   - `SYNC new=<n> changed_journeys=<n> units=<n>`: tell them in one plain sentence what changed, for example "3 new pages and 2 journeys whose code changed".
3. **Run stir → check → organise → polish → plate → report** exactly as `/chefs-table:map-app` steps 3–8, except:
   - Run the Organise step (5) only when the sync added journeys (`new` was above 0). When it only refreshed existing journeys, skip it so their groups stay put.
   - In the Polish step (6), polish only the areas the sync touched: `journeys polish start --areas touched` plus the budget flags. `touched` means the areas the sync wrote journeys into, as the map has them after organising; you can also list them yourself as `--areas a,b`.
