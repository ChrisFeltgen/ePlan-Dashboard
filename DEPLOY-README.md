# Review Workload Dashboard - cPanel deployment

## What's in this package

- `server.js` - the HTTP server (serves the page, handles Refresh Now)
- `collector.js` - pulls data from the ProjectDox API and builds the snapshot
- `workload-dashboard.html` - the dashboard page itself
- `copb-logo.png` - the header logo
- `package.json` - lets cPanel's Node.js tooling recognize this as a Node app

Nothing else is included on purpose - no cached data, no old CSV exports, no
diagnostic scripts. The app creates its own `data/` folder the first time it
runs (cache files, the snapshot, `workload-history/`) and keeps updating it
from there - kept separate from these five files so the app root stays just
"the code," not a growing pile of generated files next to it. **If you're
upgrading an existing deployment** that still has cache/snapshot files sitting
loose in the app root from before this change, just upload the new files as
usual - the app moves anything it finds in the old spot into `data/`
automatically on its next run, so existing cached data and history aren't
lost.

## 0. Verify network reachability first (do this before anything else)

This app calls `https://pompanobeach-fl-us-projectdoxwebapi.avolvecloud.com`
directly from wherever it runs. That's worked fine from your own machine and
the City's network - it is **not confirmed to work from a scrapcraft.dev/
cPanel host**. Some municipal systems allow-list which IP addresses may call
their API, which would block this entirely from an unrelated host.

Before setting anything else up, get a terminal on the cPanel host (SSH, or
cPanel's "Terminal" feature if enabled) and run:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://pompanobeach-fl-us-projectdoxwebapi.avolvecloud.com/User/Login
```

Any HTTP response code (even a 4xx/5xx - that still means the connection
itself got through) means you're likely fine. If it hangs, times out, or the
connection is refused/reset, the ProjectDox API is blocking this host and
you'll need to get scrapcraft.dev's outbound IP added to an allow-list (or
host this somewhere on the City's own network instead) before continuing.

## 1. Upload

Upload this folder's contents (the four files plus `package.json` - not the
folder itself) directly into the app root you create in step 2, e.g. via
FTP/SFTP or cPanel File Manager. All 5 files should sit flat in that
directory, not nested in a subfolder.

## 2. Create the Node.js app in cPanel

cPanel -> **Setup Node.js App** -> **Create Application**:

| Field | Value |
|---|---|
| Node.js version | 18.x or newer (needs native `fetch`, no older) |
| Application mode | Production |
| Application root | the directory you uploaded to |
| Application URL | whichever domain/subdomain/path you want this reachable at |
| Application startup file | `server.js` |

Click **Create**. Don't set an environment variable for `PORT` - cPanel/
Passenger assigns that itself and `server.js` already reads it from
`process.env.PORT`.

If your Application URL is a **subpath** of a domain (e.g.
`scrapcraft.dev/ePlan-Dashboard`) rather than its own subdomain, that's fine
- the page uses relative links so it works either way, and Passenger
automatically redirects a bare request for the app's base path to the
trailing-slash form so relative links resolve correctly.

## 3. Set environment variables

Still in the Node.js app's settings page, add these under **Environment
variables**:

| Name | Value | Required? |
|---|---|---|
| `PROJECTDOX_ADMIN_EMAIL` | the ProjectDox admin account email | Yes - Refresh Now won't work without it |
| `PROJECTDOX_ADMIN_PASSWORD` | its password | Yes |
| `DASHBOARD_USER` | a username you choose for this dashboard | **Strongly recommended** |
| `DASHBOARD_PASSWORD` | a password you choose | **Strongly recommended** |

**About `DASHBOARD_USER`/`DASHBOARD_PASSWORD`:** this dashboard shows
internal review data - project names, addresses, and reviewer names. Setting
both of these turns on an HTTP login prompt for the whole app (added
specifically for this deployment). Leaving them blank leaves it open to
anyone who finds the URL. Pick something not reused elsewhere.

## 4. Install and start

Click **Run NPM Install** if you like, but this app has zero external
dependencies, so it's a no-op - if that step errors out (a known CloudLinux
Node Selector quirk with some cPanel versions), it's safe to just skip it and
click **Restart** (or **Start**) directly instead.

## 5. First load

Open the Application URL. You should get an HTTP Basic Auth prompt (if you
set the dashboard credentials in step 3), then the dashboard page itself. The
page loads from `workload-snapshot.json`, which doesn't exist until the
first refresh - expect an empty/error state until you click **Refresh Now**
once.

That first refresh is the slow one (everything pulled fresh, likely
1-2 minutes). After that, instance/user/project caches and the 6-hour
review-history cache make subsequent refreshes much faster (seconds to
~15s), matching what you've seen running it locally.

## 6. Optional: automatic refresh on a schedule

There's no built-in scheduler - refreshing is manual (the **Refresh Now**
button) by design, same as the local setup. If you want it to refresh itself
periodically, cPanel's **Cron Jobs** page can do it with a `curl` call, e.g.
every 2 hours:

```bash
curl -s -u 'DASHBOARD_USER:DASHBOARD_PASSWORD' -X POST https://your-app-url/refresh
```

Replace the URL and credentials with your actual values. Only set this up if
you want it - the dashboard works fine with manual refreshes only.

## 7. Completed-task history (Day / Range view)

The **Completed today** panel has a **Period** selector: **Today** (live),
**Day** (one date, plus the list of individual reviews completed that day), and
**Range** (summary counts for a date range, with quick "Last 7 days / Last 30
days / This month" buttons).

This works from small per-day files the collector saves in a
`workload-history/` folder next to the other cache files (one
`YYYY-MM-DD.json` per day, roughly 100-150 KB each). Nothing to set up - the
folder is created automatically, and each refresh:

- adds the day's completions to today's file (a day's file only ever grows),
- re-checks the last 14 days (a just-closed workflow's tasks can take a while
  to show up in ProjectDox's historical tables), and
- backfills up to 15 older missing days toward the last 90, so history fills in
  over the first several refreshes after this is deployed instead of making
  one refresh very long.

Days that haven't been backfilled yet are flagged in the panel ("N days in
this range have no recorded history yet") rather than shown as zero.

Optional environment variables (defaults shown):

| Name | Default | Meaning |
|---|---|---|
| `HISTORY_DAYS` | `90` | How far back the collector keeps backfilling |
| `HISTORY_MAX_NEW_DAYS_PER_RUN` | `15` | How many older missing days to backfill per refresh |
| `HISTORY_FORCE_RESCHEMA` | unset | One-time backfill: see below |

Requires the updated `server.js` too (it serves the `/history` endpoint).

**`HISTORY_FORCE_RESCHEMA`:** whenever a new piece of information is added to
what a saved day records (e.g. the project description was added after this
was first deployed), only new and recently-settled days pick it up
automatically - an already-settled day keeps its old, shorter rows forever
otherwise. Setting this environment variable (to anything, e.g. `1`) makes
the collector also backfill that missing information into already-recorded
older days, a few per refresh (same budget as `HISTORY_MAX_NEW_DAYS_PER_RUN`).
It's safe to leave set indefinitely - once every recorded day has caught up,
it's a cheap no-op each refresh - but there's no need to keep it once the
history folder has stopped changing after a refresh or two. **Remember to
click Save on the variable itself in cPanel** - it's easy to add the row and
not notice it never actually saved.

## Troubleshooting

- **App won't start / 503 errors:** cPanel's Node.js app page has a link to
  the app's stderr log - check there first for a startup error (most likely
  cause: a typo'd environment variable, or the Node version being below 18).
- **Refresh Now fails immediately:** almost always missing/wrong
  `PROJECTDOX_ADMIN_EMAIL`/`PROJECTDOX_ADMIN_PASSWORD`, or the network
  reachability problem from step 0.
- **Changed an environment variable and nothing changed:** you need to
  **Restart** the app from the Node.js app page for env var changes to take
  effect - they're only read at process startup.
