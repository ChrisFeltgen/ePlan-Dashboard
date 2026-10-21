# ePlan Dashboard

Staff dashboard for ePlan (ProjectDox) review workload for the City of Pompano Beach.

## Contents
- `server.js` - entry point; serves the dashboard and JSON snapshot, and handles `/refresh`, `/refresh-status` and `/history`. Run with `npm start` (port 5757 by default).
- `collector.js` - pulls ProjectDox data and writes the snapshot and caches under `data/`
- `workload-dashboard.html` - the dashboard page
- `package.json` / `DEPLOY-README.md` - deploy metadata and steps (copied from the server)
- `Get-WorkloadSnapshot.ps1` / `Get-ProjectDoxReviewWorkload.ps1` - original PowerShell collectors (candidates for removal)
- `Register-WorkloadScheduledTask.ps1` - scheduled refresh task (candidate for removal)
- `Investigate-Workload*.ps1` - data-source investigation scripts (candidates for removal)
- `.preview-server.js` - static-only preview server, superseded by `server.js` (candidate for removal)

## Configuration
- `PROJECTDOX_ADMIN_EMAIL` / `PROJECTDOX_ADMIN_PASSWORD` - required for the collector
- `DASHBOARD_USER` / `DASHBOARD_PASSWORD` - required: the server refuses to start without them. For local development only, set `ALLOW_NO_AUTH=1` to run without a login

## Notes
- `data/`, `stderr.log`, `tmp/`, `public/`, `node_modules/` and the `web/` server copy are git-ignored.
