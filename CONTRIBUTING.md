# Contributing to Chef's Table

Thanks for helping out. A few ground rules keep the project small and easy to trust.

## Ground rules

- **Zero runtime dependencies.** Use Node built-ins only. If you think you need a package, open an issue first.
- **Every exported function has JSDoc.** Say what it does, what its parameters mean, and what it returns.
- **Tests live next to the change.** Write them with `node:test` and run them with:

  ```sh
  node --test
  ```

## Making a change

- Keep pull requests small (ideally under 750 added lines) and focused on one change.
- De-duplicate before you open a PR. Look for existing helpers and code paths you can reuse.
- Hooks must stay fast. PreToolUse and PostToolUse hooks must finish in under 100ms, and Stop hooks in under 500ms. A hook must never block the same session twice in one turn.

## Pull request descriptions

Start with the goal in one or two sentences, then cover:

- **What changed:** the main edits, briefly.
- **How to test:** the commands or steps a reviewer can run.
- **Risks:** real risks only.
