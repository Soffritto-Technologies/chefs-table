---
description: Work out what follows what at every level of an existing map, with one cheap helper
---

Add order to the existing journey map so every level (the whole app, each area, each journey) reads as a flow.

CLI: `node "${CLAUDE_PLUGIN_ROOT}/bin/journeys.mjs"` (written below as `journeys`).

1. Run `journeys order brief`. It prints `ORDER_BRIEF <brief> tokens~<n>`. Tell the builder the size in one short sentence.
2. Start one helper with the Agent tool as subagent type `chefs-table:mapper` (or `general-purpose` if that type isn't available), **model `haiku`**, using this prompt with the marker as its first line:

   > [chefs-table unit order]
   > Read the brief at <brief> and follow it exactly. Write the JSON it asks for, run the apply command it gives, and reply with ORDERED or the errors.
3. **`ORDER_INVALID`:** give the helper one retry with the errors. If it fails again, keep the map as it is and say so.
4. Run `journeys health`, then `journeys render --canonical`.
5. Tell the builder in plain words what was ordered (the `ORDERED` line) and whether health still reports parts with no known order.
