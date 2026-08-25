# Organix Global Export — Vercel Deployment

This is the **Vercel-ready** version of the app. Vercel is serverless (no always-on server, no persistent local disk), so this version uses a hosted **Postgres database (Neon)** instead of the SQLite file used in the local/Render version — Neon connects to Vercel with a couple of clicks and needs no separate signup.

## What changed from the local version

| | Local version | This Vercel version |
|---|---|---|
| Backend | Single `server.js`, always running | `api/index.js`, a serverless function |
| Database | SQLite file (`organix.db`) | Postgres via Neon (persists properly on serverless) |
| Routing | Built-in `http` server | `vercel.json` rewrite sends all `/api/*` calls to one function |

The frontend (everything in `/public`) is unchanged — same pages, same look.

## Deployment steps

**1. Push this project to GitHub** (drag-and-drop upload on github.com works — no `git` command needed). Make sure `api/`, `lib/`, `public/`, `package.json`, and `vercel.json` are all in the repo root.

**2. Import into Vercel**
- Go to vercel.com → Sign up/log in with GitHub
- "Add New" → "Project" → select your repo → Deploy
- The first deploy will succeed but the site won't work yet — it has no database connected.

**3. Connect a database (Neon, via Vercel's Storage tab)**
- Open your project in the Vercel dashboard → **Storage** tab
- Click **Connect Database** → choose **Neon (Postgres)** from the marketplace → follow the prompts to create it
- When asked which environments should get access, select **Production** (and Preview/Development if you want)
- This automatically sets a `DATABASE_URL` environment variable — you don't need to copy/paste anything

**4. Redeploy**
- Go to the **Deployments** tab → click the ⋯ menu on the latest deployment → **Redeploy**
- (This step is needed so the function picks up the new `DATABASE_URL`)

**5. Open your live URL**
- Vercel gives you a URL like `https://your-project.vercel.app`
- The database schema and demo data are created automatically the first time the site is opened — no manual setup step

## Demo logins

| Role   | Email                  | Password      |
|--------|-------------------------|---------------|
| Admin  | admin@organix.pk        | Admin@12345   |
| Vendor | vendor1@organix.pk      | Vendor@123    |
| Vendor | vendor2@organix.pk      | Vendor@123    |
| Buyer  | buyer1@organix.pk       | Buyer@123     |

## If something doesn't work

- **"No database connected" error on any page:** Storage isn't connected yet, or you haven't redeployed since connecting it — repeat steps 3–4.
- **500 errors generally:** check Vercel dashboard → your project → **Logs** tab, which shows the real error from the function.
