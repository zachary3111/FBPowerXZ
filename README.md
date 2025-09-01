# FBPowerXZ

Apify actor for Facebook post search (Playwright + Crawlee).

## Run
- Build: Dockerfile uses `apify/actor-node-playwright:22`.
- Start: `npm start` runs `src/main.js`.

## Inputs
- `query` (string, required)
- `recent_posts` (boolean)
- `start_date`, `end_date` (YYYY-MM-DD)
- `maxResults` (int)
- `proxy` (object)
- `cookies` (array of Playwright cookies)
- `session` (object)

> Use only on content you’re allowed to access and respect applicable ToS and laws.
