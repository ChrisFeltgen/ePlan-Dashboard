# Deployment - Windows Server

The app is a single Node.js process with no third-party dependencies. It
serves the dashboard over HTTP and has **no built-in login**, so run it behind
IIS (reverse proxy) or another front end and restrict access there (network
rules, Windows Authentication, etc.). The dashboard shows project names,
addresses and reviewer names.

## Files
`server.js`, `collector.js`, `workload-dashboard.html`,
`package.json`. The app creates `data/` on first run (snapshot, caches,
`workload-history/`). Back it up if history matters; it can be deleted to
rebuild from scratch.

## 1. Prerequisites
- Node.js 18 LTS or newer (uses built-in `fetch`).
- Outbound HTTPS from the server to
  `https://pompanobeach-fl-us-projectdoxwebapi.avolvecloud.com`. Verify:

      curl.exe -s -o NUL -w "%{http_code}\n" https://pompanobeach-fl-us-projectdoxwebapi.avolvecloud.com/User/Login

  Any HTTP status means the connection works; a timeout means the API is
  blocked from this host.

## 2. Install
Copy the files above to e.g. `C:\Apps\ePlan-Dashboard`. Run the service under
an account with read access to that folder and write access to `data\`.
There is nothing to `npm install`.

## 3. Configuration
Set these as machine- or service-level environment variables (or in the
service wrapper's configuration):

| Name | Required | Notes |
|---|---|---|
| `PROJECTDOX_ADMIN_EMAIL` | Yes | ProjectDox account used by the collector |
| `PROJECTDOX_ADMIN_PASSWORD` | Yes | |
| `PORT` | No | Default 5757 |
| `AUTO_REFRESH_MINUTES` | No | e.g. `120`. Off by default; refresh is otherwise manual via **Refresh Now** |

Environment variables are read at process start; restart the service after
changing them.

## 4. Run as a Windows service
Use a service wrapper such as NSSM or WinSW pointing at
`node.exe server.js` with the install folder as the working directory, set
to start automatically and restart on failure. Capture stdout/stderr to a
log file.

Quick manual check before installing the service:

    cd C:\Apps\ePlan-Dashboard
    node server.js

## 5. IIS reverse proxy
Install URL Rewrite and Application Request Routing, then create a site (with
the City's TLS certificate) that proxies to `http://localhost:5757`. The app
must be served at the site root (or a dedicated host name), not a sub-path.
Restrict access to authorized City staff (e.g. IIS Windows Authentication or network rules).

## 6. First load
The dashboard shows an empty/error state until the first refresh. Click
**Refresh Now** once; the first refresh is the slow one (1-2 minutes), later
ones take seconds to ~15 s because of the caches.

## 7. Completed-task history
The **Completed today** panel's Day and Range views read per-day files
(`data\workload-history\YYYY-MM-DD.json`, roughly 100-150 KB each) saved by
each refresh. Nothing to set up. Each refresh adds the day's completions,
re-checks the last 14 days, and backfills up to 15 older missing days toward
the last 90.

| Name | Default | Meaning |
|---|---|---|
| `HISTORY_DAYS` | `90` | How far back to backfill |
| `HISTORY_MAX_NEW_DAYS_PER_RUN` | `15` | Older missing days backfilled per refresh |
| `HISTORY_FORCE_RESCHEMA` | unset | Set to any value to also backfill newly added fields into already-recorded days; harmless to leave set, unnecessary once history stops changing |

## Troubleshooting
- **Service won't start:** check the captured stderr log. Likely causes: Node older than 18 or a port already in use.
- **Refresh fails immediately:** wrong/missing ProjectDox credentials, or the API is unreachable from this host (step 1).
- **Process killed mid-refresh:** the report-table fetch is memory-heavy; give the host/service enough RAM.
- **Changed a variable, nothing changed:** restart the service.
