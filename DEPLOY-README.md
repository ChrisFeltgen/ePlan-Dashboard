# Deployment - Windows Server

The app is a single Node.js process with no third-party dependencies. It
serves the dashboard over HTTP and has **no built-in login**, so run it behind
IIS (reverse proxy) and restrict access there (Windows Authentication, network
rules, etc.). The dashboard shows project names, addresses and reviewer names.

## Files
`server.js`, `collector.js`, `workload-dashboard.html`, `package.json`.
The app creates a `data\` folder next to them on first run (see
[Generated files](#generated-files-data)).

## 1. Prerequisites
- **Node.js:** current LTS release recommended (version 18 is the minimum).
- **Outbound HTTPS** from the server to
  `https://pompanobeach-fl-us-projectdoxwebapi.avolvecloud.com`. To verify,
  run this as the service account:

      curl.exe -s -o NUL --max-time 15 -w "%{http_code}\n" https://pompanobeach-fl-us-projectdoxwebapi.avolvecloud.com/User/Login

  Any 3-digit HTTP status (even 4xx/5xx) means the connection works. `000`
  means it failed (blocked, DNS, or timed out).
- **Outbound proxy:** if internet access goes through a proxy, note that
  Node's built-in `fetch` does not use the Windows proxy settings. Either allow
  the server direct outbound access to the host above, or use a Node version
  that supports `NODE_USE_ENV_PROXY=1` together with `HTTPS_PROXY`.
- **Memory and disk:** downloading the historical tables (in a separate child
  process) is the most memory-intensive part of a refresh; allow at least 1 GB
  free for the service. `data\` grows to a few hundred MB.

## 2. Install
1. Copy the files above to a folder such as `C:\Apps\ePlan-Dashboard`.
2. Create a dedicated, low-privilege service account with these rights:
   - read access to that folder;
   - write access to `data\` (create the folder, or let the app create it, which needs write access to the parent folder);
   - outbound HTTPS access.

There is nothing to `npm install`.

## 3. Configuration
Set these as service-level environment variables (in the service wrapper's
configuration) or as machine-level variables:

| Name | Required | Notes |
|---|---|---|
| `PROJECTDOX_ADMIN_EMAIL` | Yes | ProjectDox account used to read data |
| `PROJECTDOX_ADMIN_PASSWORD` | Yes | Keep readable only by administrators and the service account |
| `PORT` | No | Default `5757` |
| `HOST` | No | Listen address. Default `127.0.0.1`, reachable only from this machine (i.e. through IIS). Use `0.0.0.0` only if clients must connect directly |
| `AUTO_REFRESH_MINUTES` | No | e.g. `120`. Off by default. The first automatic refresh runs one interval after the service starts |
| `HISTORY_DAYS` | No | See [section 7](#7-completed-task-history) |
| `HISTORY_MAX_NEW_DAYS_PER_RUN` | No | See section 7 |
| `HISTORY_FORCE_RESCHEMA` | No | See section 7 |

Variables are read at process start; restart the app (service or scheduled task) after changing them.

## 4. Keep the app running
Before installing the service, run a quick manual check from the install
folder:

    cd C:\Apps\ePlan-Dashboard
    node server.js

It should print `Review Workload Dashboard listening on http://127.0.0.1:5757/`.
Stop it with Ctrl+C.

Then register it with a service wrapper such as NSSM or WinSW:

| Setting | Value |
|---|---|
| Program | `node.exe` |
| Arguments | `server.js` |
| Working directory | The install folder |
| Startup type | Automatic, restart on failure |
| Log on as | The service account from step 2 |
| Output | Redirect stdout/stderr to log files with rotation enabled |

Example with NSSM (run from an administrator prompt):

    nssm install ePlanDashboard "C:\Program Files\nodejs\node.exe" server.js
    nssm set ePlanDashboard AppDirectory C:\Apps\ePlan-Dashboard
    nssm set ePlanDashboard AppEnvironmentExtra PROJECTDOX_ADMIN_EMAIL=... PROJECTDOX_ADMIN_PASSWORD=...
    nssm set ePlanDashboard AppStdout C:\Apps\ePlan-Dashboard\logs\out.log
    nssm set ePlanDashboard AppStderr C:\Apps\ePlan-Dashboard\logs\err.log
    nssm set ePlanDashboard AppRotateFiles 1
    nssm set ePlanDashboard AppRotateBytes 10485760
    nssm start ePlanDashboard

### Alternative: Windows Task Scheduler (no extra software)
If installing a service wrapper isn't allowed, a scheduled task can start the
app at boot. Compared with a service it has no built-in log rotation, and
environment variables must be set at machine level (Task Scheduler can't set
them per task). Machine-level variables are readable by every account that
can sign in to the server, so only use this on a server where that's
acceptable.

1. Set `PROJECTDOX_ADMIN_EMAIL`, `PROJECTDOX_ADMIN_PASSWORD` (and any optional
   variables) as **System** environment variables.
2. Create a `logs` folder in the install folder that the service account can
   write to.
3. Register the task from an administrator PowerShell prompt, replacing the
   account name:

```powershell
$app = 'C:\Apps\ePlan-Dashboard'
$action = New-ScheduledTaskAction -Execute 'cmd.exe' `
  -Argument "/c `"`"C:\Program Files\nodejs\node.exe`" server.js >> logs\out.log 2>&1`"" `
  -WorkingDirectory $app
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName 'ePlanDashboard' -Action $action -Trigger $trigger `
  -Settings $settings -User 'DOMAIN\svc-eplan' -Password (Read-Host 'Service account password') `
  -RunLevel Limited
Start-ScheduledTask -TaskName 'ePlanDashboard'
```

Notes:
- `-ExecutionTimeLimit ([TimeSpan]::Zero)` is required. Task Scheduler's
  default 3-day limit would otherwise stop the app.
- The restart settings restart the app within a minute if it exits with an
  error. Check that it's running with `Get-ScheduledTask ePlanDashboard`
  (State should be `Running`).
- To restart after changing a variable or upgrading, stop the task and make
  sure the Node process has exited (stopping the task may not end it), then
  start the task again:

  ```powershell
  Stop-ScheduledTask ePlanDashboard
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object CommandLine -like '*server.js*' |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-ScheduledTask ePlanDashboard
  ```
- `logs\out.log` grows without limit; clear or archive it periodically.

## 5. IIS reverse proxy
1. Install the **URL Rewrite** and **Application Request Routing (ARR)**
   modules.
2. In IIS Manager, at the server level: **Application Request Routing Cache** >
   **Server Proxy Settings** > check **Enable proxy**.
3. Create a site with the City's TLS certificate, served at its own host name
   or site root (not a sub-path), with this rewrite rule in its `web.config`:

```xml
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="ePlanDashboard" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://127.0.0.1:5757/{R:1}" />
        </rule>
      </rules>
    </rewrite>
  </system.webServer>
</configuration>
```

4. Restrict access to authorized staff, for example by enabling Windows
   Authentication (and disabling Anonymous) on the site, or with IP/network
   rules.

**Refresh now** returns immediately and the page follows progress by polling,
so the default ARR proxy timeout is sufficient.

## 6. First load
The dashboard shows an empty/error state until the first refresh. Click
**Refresh now** once. The first refresh is the slowest (a few minutes, while
the caches are built). After that:
- most refreshes take seconds to about 15 s;
- a refresh more than 6 hours after the historical tables were last downloaded
  downloads them again and takes longer.

Refreshes are limited to one every 5 minutes, including after a failure.

## 7. Completed-task history
The Completed panel's **Day** and **Range** views read one file per day
(`data\workload-history\YYYY-MM-DD.json`). Each refresh does three things:
- adds the day's completions to that day's file;
- re-checks the last 14 days;
- fills in up to 15 missing older days, working back toward the last 90.

A new installation therefore takes several refreshes to fill in its history.
There is nothing to set up.

| Name | Default | Meaning |
|---|---|---|
| `HISTORY_DAYS` | `90` | How far back to keep and backfill history |
| `HISTORY_MAX_NEW_DAYS_PER_RUN` | `15` | Missing older days filled in per refresh |
| `HISTORY_FORCE_RESCHEMA` | unset | Set to any value to also update already-recorded days with fields added in a newer version. A no-op once all days are updated |

## Generated files (`data\`)
| File | Contents |
|---|---|
| `workload-snapshot.json` | What the page displays (the only data file served to browsers) |
| `workload-instance-cache.json`, `workload-user-cache.json`, `workload-project-cache.json`, `workload-revision-instances-cache.json`, `workload-completed-today-cache.json` | API lookup caches. Safe to delete; rebuilt on the next refresh, which is then slower |
| `workload-report-tables-cache.json` | Cached historical task tables (the largest file). Safe to delete; downloaded again on the next refresh |
| `workload-history\`, `workload-history-lookups.json` | Completed-task history. Back these up: history older than the backfill window can't be rebuilt |

Short-lived `*.tmp` files may appear during a refresh; they are renamed into
place when complete.

## Upgrading
1. Stop the app (service or scheduled task).
2. Replace the four application files. Leave `data\` in place.
3. Start it again.

The refresh log's first line shows the running version (from `package.json`).

## Troubleshooting
- **App won't start:** check the stderr log (or `logsout.log` with Task Scheduler). Likely causes: a Node version
  older than 18, or the port already in use.
- **Refresh fails:** the page shows only a generic message; the cause is in the
  stderr log (or `logsout.log`). Common causes: wrong or missing ProjectDox credentials,
  the API unreachable from this host or needing a proxy (step 1).
- **Refresh ends with a timeout:** each API call has a time limit (1 minute for
  single lookups, 5-20 minutes for whole tables), and the historical-table
  download is stopped after 45 minutes. A refresh can't hang indefinitely;
  check connectivity to the API.
- **"could not fetch/refresh report tables" warning in the log:** the historical-table download
  failed (often memory). The refresh continues using the previous download, if
  there is one.
- **Changed a variable, nothing changed:** restart the app.
