# ePlan Dashboard

Staff dashboard for ePlan (ProjectDox) review workload for the City of Pompano Beach Building Department.

## Contents
- `server.js` - entry point; serves the dashboard and JSON snapshot, and handles `/refresh` (starts a refresh), `/refresh-status` (progress) and `/history`
- `collector.js` - pulls ProjectDox data and writes the snapshot, caches and per-day history under `data/`
- `workload-dashboard.html` - the dashboard page
- `package.json` - metadata and start script (no third-party dependencies)
- `DEPLOY-README.md` - Windows Server deployment guide

## Quick start
Requires Node.js 18 or newer.

    set PROJECTDOX_ADMIN_EMAIL=...
    set PROJECTDOX_ADMIN_PASSWORD=...
    npm start

The server listens on `127.0.0.1:5757` by default (`HOST` and `PORT` override).

## Configuration (environment variables)
| Name | Required | Purpose |
|---|---|---|
| `PROJECTDOX_ADMIN_EMAIL` / `PROJECTDOX_ADMIN_PASSWORD` | Yes, for refresh | ProjectDox account the collector uses |
| `PORT` | No | Listen port (default 5757) |
| `HOST` | No | Listen address (default `127.0.0.1`) |
| `AUTO_REFRESH_MINUTES` | No | Periodic automatic refresh; off by default |
| `HISTORY_DAYS`, `HISTORY_MAX_NEW_DAYS_PER_RUN`, `HISTORY_FORCE_RESCHEMA` | No | History backfill tuning (see DEPLOY-README.md) |

`data/` (caches, snapshot, history) is generated at runtime and git-ignored.

The app has no built-in login; restrict access at the network or IIS level.
