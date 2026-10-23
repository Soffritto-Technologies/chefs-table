# TODOS

Deferred on purpose. Each item says why it waited and where to start.

- **Route resolvers for SvelteKit, Remix and Nuxt**
  - **Why it waited:** Next.js file routes plus `path:` definitions cover most AI-built apps today. Other frameworks show as "unverified", which is honest but less useful.
  - **Start in:** `lib/anchors.mjs` `routeFromNextFile`. Add a sibling per framework and a fixture under `fixtures/`.
- **Time scrubber (v1.5)**
  - **What:** replay how the map changed turn by turn.
  - **Needs:** an append-only `.journeys/.session/<id>/history.jsonl` written at each Stop, plus a slider in `templates/journeys.html`.
- **Ghost-walk QA (v2)**
  - **What:** a headless browser walks each journey in the running app. A dot travels the arrows and turns red where the app breaks, and real screenshots sit inside the steps.
  - **Why it waited:** brittle across stacks. It needs logins and test data.
- **Other coding agents** (Cursor, Windsurf and similar)
  - **How:** publish the `journeys` CLI to npm and add an `AGENTS.md` recipe.
  - **Limit:** no approval gate, because hooks are Claude Code only.
- **Two-way editing**
  - **What:** click a node, type "change this", and it becomes Claude's next prompt.
  - **Why it waited:** first prove the map stays accurate.
- **Detect shell-made edits to existing files**
  - **Today:** new pages are caught by the route-file snapshot. Edits made through the shell to *existing* files aren't attributed to a chat.
