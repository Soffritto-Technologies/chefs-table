---
description: Update this chat's share link with the map as it is right now
---

Publish the current map so people on the share link see what you see.

CLI: `node "${CLAUDE_PLUGIN_ROOT}/bin/journeys.mjs"` (written below as `journeys`).

1. Run `journeys share`. It redraws this chat's map clean and prints `SHARE_FILE <path>` and `SHARE_URL <link or none>`.
2. Publish that file with the Artifact tool: action `publish`, `file_path` the `SHARE_FILE` path, and `url` the `SHARE_URL` link when it is not `none` (otherwise leave `url` out to make a new private artifact).
3. Give the builder the link from the result in one short sentence.
