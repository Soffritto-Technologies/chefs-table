---
description: Draw a live, zoomable map of this whole app's user journeys (first run or full refresh)
---

Map this entire app for a non-technical builder, then show it to them.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/journeys.mjs" init`. It creates `.journeys/` if missing (`journeys.json`, `config.json`, gitignore entries) and prints the session folder and CLI command to use for the rest of this chat.
2. Survey the codebase for everything a user can do or see:
   - routes and pages
   - navigation
   - forms
   - sign-in and sign-up
   - payments
   - emails and notifications
   - admin screens
   - background processes users notice

   For a large repo, split the survey across parallel subagents by folder and merge their findings.
3. Draft the map following the journeymap skill's "Writing journeys well":
   - 3–8 areas
   - one journey per user goal
   - steps in plain language
   - every step anchored to its file or route
   - `detail` on each step
   - `subflow` for steps that hide a multi-step process

   Prefer fewer, clearer journeys over exhaustive ones.
4. Write `.journeys/journeys.json`, then run `node "${CLAUDE_PLUGIN_ROOT}/bin/journeys.mjs" check`. Fix every validation error. Look at broken anchors; "unverified" is fine.
5. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/journeys.mjs" render --canonical` and `… build --render --session <id>`. Publish the printed session map with the Artifact tool, and give the builder the link.
6. Ask the builder in plain words whether this matches how their app works. Ask which journeys are missing, wrong or named in a way they wouldn't use. Apply their corrections, then render and publish again.

$ARGUMENTS
