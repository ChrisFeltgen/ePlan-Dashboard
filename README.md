# ePlan Dashboard

Staff dashboard for ePlan (ProjectDox) review workload for the City of Pompano Beach.

## Contents
- `workload-dashboard.html` - the dashboard page (reads `data/workload-snapshot.json`)
- `collector.js` - Node port of `Get-WorkloadSnapshot.ps1`; pulls ProjectDox data, writes snapshot and caches under `data/`
- `Get-WorkloadSnapshot.ps1` / `Get-ProjectDoxReviewWorkload.ps1` - original PowerShell collectors
- `Register-WorkloadScheduledTask.ps1` - registers the scheduled refresh task
- `Investigate-Workload*.ps1` - data-source investigation scripts
- `.preview-server.js` - zero-dependency static server for local preview (port 5757)

## Configuration
Requires `PROJECTDOX_ADMIN_EMAIL` and `PROJECTDOX_ADMIN_PASSWORD` environment variables.

## Notes
- `data/` is generated at runtime and is git-ignored.
- `server.js` (the `/refresh` handler that `collector.js` is called from) is not in this repo yet.
