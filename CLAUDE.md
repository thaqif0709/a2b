# Working on A2B with Claude

These rules are for Claude sessions working in this repository. Contributors: see CONTRIBUTING.md.

## Changes go through pull requests

The repository is public. Never push to `main` directly.

- Put each change on its own `claude/<short-topic>` branch, one change per commit, with a message that says what
  and why.
- Before opening the pull request: `npm test` passes, and anything visual or on the road has been tried in a browser.
- Open a pull request against `main` that fills in `.github/pull_request_template.md`. The owner reviews and merges.
- Tell the owner in the chat what the pull request changes.

## Deploying

- The live app (https://a2b-beta.pages.dev) only ever runs what's on `main`. Deploy only after the owner has merged:
  pull `main`, run `npm test`, then `npm run deploy`.
- The shop search files in `public/places/` aren't in git. Before deploying from a fresh checkout, build them
  (`pip install duckdb && npm run places`), or the deploy removes shop search from the live app. The predeploy
  step prints which data it found.
- Database changes go in a new file in `migrations/`; apply it with `npx wrangler d1 migrations apply a2b --remote`
  before deploying code that needs it.
- MapLibre and three.js are copies in `public/vendor/`, not CDN links. To upgrade either, follow "Updating MapLibre
  and three.js" in the README's deploy section.
- Never print, echo or commit the Cloudflare API token or other secrets (the TomTom key, `TESTER_EMAILS`).

## Monthly map data

A scheduled task checks for a new Overture Maps release and rebuilds the speed camera list each month. When
something changed, it rebuilds the data on a `claude/map-data-<release>` branch, opens a pull request, and
reports back; it deploys after the owner merges.
