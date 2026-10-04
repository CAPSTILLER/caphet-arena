# Deploying the CAPHET Arena demo on Vercel

This puts the watch-only demo online. It needs **no environment variables** and **no database**. About five minutes.

## Steps

1. Go to https://vercel.com/new and sign in.
2. Under "Import Git Repository" find **CAPSTILLER/caphet-arena** and click **Import**. (If it is not listed, click "Adjust GitHub App Permissions" and allow the repo. The repo is public.)
3. On the configure screen leave everything as it is:
   - Framework Preset: **Other** (the repo's `vercel.json` already says this)
   - Root Directory: `./`
   - Build Command, Output Directory, Install Command: leave empty / default
   - Environment Variables: **none needed**
4. Click **Deploy** and wait for "Congratulations".
5. Click the preview image or **Visit**. You should see the CAPHET Arena page with 10 tables, coins stacking, a leaderboard on the left and a stats strip on top.

That is all. The demo runs on a memory store, which means it works with zero setup.

## Check it when you wake up

- `/` shows the page. Click SINGLE, TWIN, TRIPLE and the arena and sub-arena numbers. Click a table to zoom. Try the volume menu ("What-if $100,000" gives perfect coins).
- Try the THEME color picker at the bottom, pause, and the speed buttons.
- `/health` should show `{"ok":true,...}`.
- `/llms.txt` has the plain-language rules. `/openapi.json` has the machine spec.
- The "replay check" line in the zoom panel should say "matches server result". `/replay/<round id>` shows the same round as JSON.
- Posting to `/join` should answer 403 "watch-only demo". That is correct.

## Optional extras (all skippable)

| What | How | Why |
| --- | --- | --- |
| **Keep the leaderboard and totals** | In the Vercel project: Storage, Create Database, Blob, connect it to the project, then redeploy. Vercel adds `BLOB_READ_WRITE_TOKEN` by itself. | Without it the leaderboard and totals restart whenever Vercel restarts the function. The tables themselves never depend on it. |
| **Custom domain** | Project Settings, Domains, add for example `arena.gearup.wtf`, then add the DNS record Vercel shows (a CNAME to `cname.vercel-dns.com`). | Nice address. |
| `VOLUME_OVERRIDE_USD` | Environment Variables, for example `30000`. | Pins the "live" CAPH volume so coins look good. Real volume is very low, so live coins are poor. Leave unset to show the real market. |
| `FALLBACK_VOLUME_USD` | Number, default 0. | Volume to use if the market lookup fails. |
| `DEMO_MODE` | Default `on`. Do not set to `off` on a public site. | `off` opens the real play-coin API (join, place, cash out) to everyone. |
| `SERVER_SECRET`, `HOUSE_SECRET`, `ADMIN_SECRET`, `AUTH_MODE` | Only for the real API later. | Not used by the demo. |

The env var list for the real game and the onchain record keeper is in README.md.

## If the deploy fails

Open the project, then Deployments, click the failed one, and read the Build Logs (build problems) or Runtime Logs under Functions (page shows an error). Send that text over. Nothing in this repo needs a build step, so most problems are a setting on the Vercel screen (Framework Preset should be Other, Node.js version 22.x under Settings, General).

## What is not tested

This repo was tested locally and with a fake Vercel Blob. It has not been run on Vercel itself, because the box that built it must not touch Vercel. The Vercel entry file is `api/index.ts`, using Vercel's documented `fetch` export.
