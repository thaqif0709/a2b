# Contributing to A2B

Thanks for helping. A2B is a free, open source navigation app, built in public and still a beta. Bug reports,
ideas and code are all welcome.

## Reporting a bug or idea

Open an issue. For anything on the road, the most useful things are:

- a screenshot or screen recording
- where it happened (a place name or a pin; you don't need to share your home)
- your phone and browser (e.g. iPhone 15, Safari, added to the home screen)

Wrong roads, missing places and closures often come from the map data rather than the app. If you can, check the
spot on [openstreetmap.org](https://www.openstreetmap.org): fixing it there fixes it for every app that uses the map.

## Running A2B on your computer

You need Node.js 22.20 or newer (the tests use its built-in SQLite, which mishandles numbered parameters like `?1` before 22.20). No Cloudflare account or API keys are needed to work on it.

```bash
npm install
npm run dev          # http://localhost:8787, with its own local database
npm test             # unit and API tests, no network needed
```

Search, routing and map tiles use the same free public servers as the live app, so they work locally too. Please
go easy on them (no load tests or scripted bulk requests).

Optional extras:

- **Demo drive** (fake GPS along a route) is for tester accounts. Create `.dev.vars` (it's git-ignored) with
  `TESTER_EMAILS=you@example.com`, then sign up locally with that email. It appears under Settings › Testing.
- **Shop search data** and the **roads under construction** list are built from Overture Maps:
  `pip install duckdb && npm run places && npm run construction`. The shop files are big and aren't kept in git.

GPS only works on `https://` or `localhost`. To try it on your phone, deploy your own copy (see the README) or
use `npx wrangler dev --ip 0.0.0.0` for everything except location.

## Sending a change

1. Fork the repo and create a branch from `main`.
2. Keep each pull request to one thing: one bug, one feature. Small PRs get reviewed sooner.
3. Add or update tests for logic you change (`test/`), and make sure `npm test` passes.
4. Try it in a browser, ideally on a phone-sized screen, and say in the PR what you tested.
5. Open a pull request with what changed and why, plus screenshots for anything visual.
6. Agree to the [Contributor License Agreement](CLA.md) (a checkbox in the pull request).

The maintainer reviews every pull request before it's merged, and deploys the live app themselves. Contributors
never need the app's Cloudflare account or secrets.

### What fits

- **Keep it free to run.** A2B runs on free tiers and free public services. Changes that need a paid API or a
  heavy server are hard to accept; open an issue first to talk them over.
- **No secrets in the code.** Keys and personal emails go in Cloudflare secrets or `.dev.vars`, never in git.
- **Match the code around it.** Plain JavaScript modules, no build step. Comments explain *why*, briefly.
- **Respect the data sources.** Credit OpenStreetMap and Overture, follow their usage policies, and keep requests
  to the public servers modest (cache where you can).
- **Safety first.** Nothing that encourages using the phone while driving.

## Licence and the contributor agreement

A2B is licensed under the [GNU AGPL v3.0 or later](LICENSE) with the additional terms in [NOTICE](NOTICE)
(keeping the author credit, marking changed versions, and not using the A2B name or logo for them). It will stay
free and open source. New source files start with the same two-line licence and copyright header as the others.

Before your first pull request can be merged, you need to agree to the [Contributor License Agreement](CLA.md).
In short: you keep the copyright to your work, and you give the maintainer a licence to use it, including the
option to also offer A2B under other licences (for example to a company that can't use the AGPL). That keeps the
project sustainable without taking anything away from the open source version. Tick the box in the pull request
template to agree, or write "I agree to the A2B CLA" in your pull request.
