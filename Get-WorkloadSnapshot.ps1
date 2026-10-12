#requires -Version 5.1
<#
.SYNOPSIS
    The real collector for the review-workload dashboard. Pulls open tasks in
    bulk, resolves each referenced workflow instance via REST (cached to disk
    across runs), and writes a compact JSON snapshot for a static dashboard
    page to read.

.DESCRIPTION
    Data path (derived and verified live - see Investigate-WorkloadDataSources.ps1,
    Investigate-WorkloadReportViews.ps1, Measure-TableSizes.ps1,
    Diagnose-WFlowInstances.ps1, Diagnose-WorkflowInstanceREST.ps1):

      WFlowTasks (QueryDatabase, ~40 MB, ~50k rows)
        WFlowTaskStatusTypeID: 2=Accepted, 3=Pending (others are Completed/
        SystemClosed/Reassigned and excluded). WFlowReviewCycleID is non-null
        only for real department-review tasks (applicant/system tasks have it
        null). GroupID/GroupName are already denormalized on this table.
             |  WFlowReviewCycleID
             v
      WFlowReviewCycles (QueryDatabase, ~2 MB, ~5k rows) -> WFlowInstanceID
             |  WFlowInstanceID
             v
      WorkflowInstance/GetWorkflowInstance (REST, per distinct instance ID)
        -> EntityID (ProjectID), WFlowInstanceStateID/Name, WFlowID

    IMPORTANT - two dead ends this was built on top of, kept here so they
    don't get re-tried:
      - Query/QueryDatabase's "select" operation always returns the WHOLE
        table; UpdateClause does NOT filter it server-side.
      - The raw "WFlowInstances" table is empty, and the parallel full-word
        "WorkflowInstances" table (144k rows) is a STALE/legacy mirror - it
        only resolved ~49% of currently-open tasks' instances, and was
        confirmed WRONG even for ones it did resolve (reported an instance as
        "Complete" that WorkflowInstance/GetWorkflowInstance shows is still
        Active). Only the REST endpoint is trustworthy for instance state.

    Because per-instance REST resolution is the expensive step (~80ms each,
    ~2,800 distinct instances on this system), results are cached to
    -InstanceCacheJson and reused across runs - a run only looks up instances
    not already cached (or older than -MaxCacheAgeMinutes). The cache is
    saved every -SaveEvery lookups, so closing the window mid-run doesn't
    lose progress.

    Project name/status come from a previously-pulled full project CSV (see
    Update-ProjectDoxPagerPhone.ps1 / Get-ProjectDoxReviewWorkload.ps1's
    -RawPullCsv output) rather than another live pull - acceptable staleness
    for a display field. Template name comes from the small, already-cached
    WFlows table dump (workload-probe-WFlows.json).

.PARAMETER BaseUrl
    Root of the ProjectDox Web API, no trailing slash.

.PARAMETER ProjectListCsv
    A previously pulled project list CSV with ProjectID/Name/Status columns,
    used to label projects without another live pull.

.PARAMETER WFlowsJson
    Cached dump of the WFlows table (WFlowID -> WFlowName), used to label the
    project template. Defaults to workload-probe-WFlows.json from the earlier
    discovery pass.

.PARAMETER InstanceCacheJson
    Where resolved workflow-instance data is cached across runs. Defaults to
    workload-instance-cache.json next to this script (NOT timestamped).

.PARAMETER MaxCacheAgeMinutes
    Re-resolve a cached instance via REST if its cache entry is older than
    this, instead of trusting it forever (an instance could complete after
    being cached). Default 120 (2 hours).

.PARAMETER SaveEvery
    Flush the instance cache to disk after this many new REST lookups.
    Default 100.

.PARAMETER SnapshotJson
    Where the dashboard-ready JSON snapshot is written (fixed filename - the
    dashboard always reads this).

.PARAMETER DetailCsv
    Where the full per-task detail rows are written for audit/debugging.

.EXAMPLE
    .\Get-WorkloadSnapshot.ps1
#>
[CmdletBinding()]
param(
    [string]$BaseUrl = "https://pompanobeach-fl-us-projectdoxwebapi.avolvecloud.com",

    [string]$ProjectListCsv,

    [string]$WFlowsJson,

    [string]$InstanceCacheJson,

    [string]$UserCacheJson,

    [int]$MaxCacheAgeMinutes = 120,

    [int]$MaxUserCacheAgeMinutes = 1440,

    [int]$SaveEvery = 100,

    [string]$SnapshotJson,

    [string]$DetailCsv
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# $PSScriptRoot is unreliable in param()-block default values when this script
# is launched via `powershell.exe -File <path>` from a spawned child process
# (e.g. server.js) rather than run directly - it works when you type
# .\Get-WorkloadSnapshot.ps1 yourself, but comes back empty under -File in
# that context. Resolve the directory defensively instead, and fill in any
# path parameter the caller didn't override.
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot }
    elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path }
    else { (Get-Location).Path }

if (-not $ProjectListCsv)    { $ProjectListCsv    = Join-Path $ScriptDir "projectdox-raw-pull-20260915-230752.csv" }
if (-not $WFlowsJson)        { $WFlowsJson        = Join-Path $ScriptDir "workload-probe-WFlows.json" }
if (-not $InstanceCacheJson) { $InstanceCacheJson = Join-Path $ScriptDir "workload-instance-cache.json" }
if (-not $UserCacheJson)     { $UserCacheJson     = Join-Path $ScriptDir "workload-user-cache.json" }
if (-not $SnapshotJson)      { $SnapshotJson      = Join-Path $ScriptDir "workload-snapshot.json" }
if (-not $DetailCsv)         { $DetailCsv         = Join-Path $ScriptDir "workload-detail-$(Get-Date -Format 'yyyyMMdd-HHmmss').csv" }

function Connect-ProjectDox {
    param([string]$BaseUrl)

    # Non-interactive path for Task Scheduler: set these on the account the
    # scheduled task runs as. Falls back to an interactive prompt (e.g. for a
    # manual test run) when they're not set. Same pattern as projectdox-test.ps1.
    $envEmail = $env:PROJECTDOX_ADMIN_EMAIL
    $envPassword = $env:PROJECTDOX_ADMIN_PASSWORD

    if ($envEmail -and $envPassword) {
        Write-Host "Using PROJECTDOX_ADMIN_EMAIL/PROJECTDOX_ADMIN_PASSWORD from the environment (non-interactive)."
        $email = $envEmail
        $plainPassword = $envPassword
    } else {
        $cred = Get-Credential -Message "ProjectDox account (must be a System Administrator)"
        $email = $cred.UserName
        $plainPassword = $cred.GetNetworkCredential().Password
    }

    $body = @{ Email = $email; Password = $plainPassword } | ConvertTo-Json
    $response = Invoke-RestMethod -Uri "$BaseUrl/User/Login" -Method Post -ContentType "application/json" -Body $body
    $sessionId = $response.SessionID
    if (-not $sessionId) { throw "No SessionID in login response." }
    return $sessionId
}

function Get-FirstPropertyValue {
    param($Object, [string[]]$CandidateNames)
    if ($null -eq $Object) { return $null }
    foreach ($name in $CandidateNames) {
        $prop = $Object.PSObject.Properties | Where-Object { $_.Name -ieq $name } | Select-Object -First 1
        if ($prop -and $null -ne $prop.Value -and $prop.Value -ne '') { return $prop.Value }
    }
    return $null
}

function Get-TableRows {
    param([string]$BaseUrl, [hashtable]$Headers, [string]$TableName)
    Write-Host "Pulling $TableName ..." -NoNewline
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $payload = @{ IsProjectDox = $true; ConnectionString = $null; Operation = "select"; TableName = $TableName } | ConvertTo-Json
    $resp = Invoke-RestMethod -Uri "$BaseUrl/Query/QueryDatabase" -Method Post -Headers $Headers -ContentType "application/json" -Body $payload
    $sw.Stop()
    $prop = $resp.PSObject.Properties | Where-Object { $_.Name -ieq $TableName } | Select-Object -First 1
    $rows = if ($prop) { @($prop.Value) } else { @($resp) }
    Write-Host (" {0} rows in {1:N0}s" -f $rows.Count, $sw.Elapsed.TotalSeconds)
    return $rows
}

# ---------------------------------------------------------------------------
# Load reference data that doesn't need a fresh pull
# ---------------------------------------------------------------------------

$projectByID = @{}
if (Test-Path $ProjectListCsv) {
    Write-Host "Loading project list from $ProjectListCsv ..."
    foreach ($p in Import-Csv -Path $ProjectListCsv) {
        if ($p.ProjectID) { $projectByID[[string]$p.ProjectID] = $p }
    }
    Write-Host "$($projectByID.Count) projects loaded."
} else {
    Write-Warning "ProjectListCsv not found at $ProjectListCsv - project names/status will be blank. Pass -ProjectListCsv to point at a valid pull."
}

$wflowNameByID = @{}
if (Test-Path $WFlowsJson) {
    foreach ($w in (Get-Content $WFlowsJson -Raw | ConvertFrom-Json)) {
        if ($null -ne $w.WFlowID) { $wflowNameByID[[string]$w.WFlowID] = $w.WFlowName }
    }
    Write-Host "$($wflowNameByID.Count) workflow template names loaded from $WFlowsJson."
} else {
    Write-Warning "WFlowsJson not found at $WFlowsJson - template names will show as WFlow<ID>."
}

$instanceCache = @{}
if (Test-Path $InstanceCacheJson) {
    $cached = Get-Content $InstanceCacheJson -Raw | ConvertFrom-Json
    foreach ($prop in $cached.PSObject.Properties) { $instanceCache[$prop.Name] = $prop.Value }
    Write-Host "$($instanceCache.Count) workflow instances loaded from cache ($InstanceCacheJson)."
}

function Save-InstanceCache {
    $instanceCache | ConvertTo-Json -Depth 4 | Out-File -FilePath $InstanceCacheJson -Encoding utf8
}

# ---------------------------------------------------------------------------

Write-Host "`nLogging into ProjectDox at $BaseUrl ..."
$sessionId = Connect-ProjectDox -BaseUrl $BaseUrl
$headers = @{ SessionID = $sessionId }
Write-Host "Logged in.`n"

$overallSw = [System.Diagnostics.Stopwatch]::StartNew()

$tasks        = Get-TableRows -BaseUrl $BaseUrl -Headers $headers -TableName 'WFlowTasks'
$reviewCycles = Get-TableRows -BaseUrl $BaseUrl -Headers $headers -TableName 'WFlowReviewCycles'

$cycleToInstance = @{}
foreach ($c in $reviewCycles) {
    if ($null -ne $c.WFlowReviewCycleID) { $cycleToInstance[[string]$c.WFlowReviewCycleID] = $c.WFlowInstanceID }
}

$openTasks = $tasks | Where-Object {
    ($_.WFlowTaskStatusTypeID -eq 2 -or $_.WFlowTaskStatusTypeID -eq 3) -and $_.WFlowReviewCycleID
}
Write-Host "$($openTasks.Count) open department-review tasks (out of $($tasks.Count) total task rows)."

# --- Resolve each distinct WFlowInstanceID via REST (cached) ---------------

$distinctInstanceIDs = $openTasks |
    ForEach-Object { $cycleToInstance[[string]$_.WFlowReviewCycleID] } |
    Where-Object { $_ } |
    Sort-Object -Unique

Write-Host "$($distinctInstanceIDs.Count) distinct workflow instances referenced."

$now = Get-Date
$toResolve = New-Object System.Collections.Generic.List[object]
foreach ($id in $distinctInstanceIDs) {
    $key = [string]$id
    $entry = $instanceCache[$key]
    $isFresh = $entry -and $entry.CachedAt -and ((New-TimeSpan -Start ([datetime]$entry.CachedAt) -End $now).TotalMinutes -lt $MaxCacheAgeMinutes)
    if (-not $isFresh) { $toResolve.Add($id) }
}
Write-Host "$($toResolve.Count) instance(s) need a fresh REST lookup ($($distinctInstanceIDs.Count - $toResolve.Count) served from cache)."

$lookupCount = 0
foreach ($id in $toResolve) {
    $lookupCount++
    if ($lookupCount % 25 -eq 0 -or $lookupCount -eq $toResolve.Count) {
        Write-Progress -Activity "Resolving workflow instances" -Status "$lookupCount of $($toResolve.Count)" -PercentComplete (($lookupCount / [Math]::Max($toResolve.Count,1)) * 100)
    }
    try {
        $inst = Invoke-RestMethod -Uri "$BaseUrl/WorkflowInstance/GetWorkflowInstance?wflowInstanceID=$id" -Method Get -Headers $headers
        $instanceCache[[string]$id] = [pscustomobject]@{
            WFlowInstanceID      = $inst.WFlowInstanceID
            WFlowID              = $inst.WFlowID
            EntityID             = $inst.EntityID
            WFlowInstanceStateID = $inst.WFlowInstanceStateID
            WFlowInstanceStateName = $inst.WFlowInstanceStateName
            InstanceName         = $inst.InstanceName
            DateCompleted        = $inst.DateCompleted
            CachedAt             = $now.ToString('o')
        }
    }
    catch {
        Write-Warning "GetWorkflowInstance($id) failed: $($_.Exception.Message)"
    }

    if ($lookupCount % $SaveEvery -eq 0) { Save-InstanceCache }
}
Write-Progress -Activity "Resolving workflow instances" -Completed
Save-InstanceCache
Write-Host "Instance cache saved to $InstanceCacheJson ($($instanceCache.Count) total entries)."

# --- Join everything together -----------------------------------------------

$detailRows = New-Object System.Collections.Generic.List[object]
$skippedNotActive = 0
$skippedUnresolved = 0

foreach ($t in $openTasks) {
    $wflowInstanceID = $cycleToInstance[[string]$t.WFlowReviewCycleID]
    $inst = if ($wflowInstanceID) { $instanceCache[[string]$wflowInstanceID] } else { $null }

    if (-not $inst) { $skippedUnresolved++; continue }
    if ($inst.WFlowInstanceStateID -ne 1) { $skippedNotActive++; continue }  # 1 = Active

    $status = switch ([int]$t.WFlowTaskStatusTypeID) { 2 { 'Accepted' } 3 { 'Pending' } default { "Unknown($($t.WFlowTaskStatusTypeID))" } }
    $proj = $projectByID[[string]$inst.EntityID]
    $templateName = $wflowNameByID[[string]$inst.WFlowID]
    if (-not $templateName) { $templateName = "WFlow$($inst.WFlowID)" }

    $detailRows.Add([pscustomobject]@{
        WFlowTaskID      = $t.WFlowTaskID
        TaskName         = $t.TaskName
        GroupID          = $t.GroupID
        GroupName        = $t.GroupName
        TaskStatus       = $status
        UserID           = $t.UserID
        DateCreated      = $t.DateCreated
        DateDue          = $t.DateDue
        WFlowInstanceID  = $wflowInstanceID
        WorkflowTemplate = $templateName
        ProjectID        = $inst.EntityID
        ProjectName      = if ($proj) { $proj.Name } else { $null }
        ProjectStatus    = if ($proj) { $proj.Status } else { $null }
        AssignedUserName = $null
    })
}

if ($skippedUnresolved -gt 0) { Write-Warning "$skippedUnresolved open task(s) skipped - instance lookup failed/unresolved." }
if ($skippedNotActive -gt 0) { Write-Host "$skippedNotActive open task(s) skipped - parent workflow instance is no longer Active (stale task)." }

# --- Resolve reviewer names for Accepted tasks ------------------------------
# User/GetUsersByID (plural, comma-separated IDs) came back empty when tested
# live - the singular User/GetUser?userID=X works fine and returns FullName
# directly, so that's what's used here, one call per distinct UserID (cached
# across runs since reviewer identities rarely change).

$userCache = @{}
if (Test-Path $UserCacheJson) {
    $cachedUsers = Get-Content $UserCacheJson -Raw | ConvertFrom-Json
    foreach ($prop in $cachedUsers.PSObject.Properties) { $userCache[$prop.Name] = $prop.Value }
    Write-Host "$($userCache.Count) reviewer names loaded from cache ($UserCacheJson)."
}

function Save-UserCache {
    $userCache | ConvertTo-Json -Depth 4 | Out-File -FilePath $UserCacheJson -Encoding utf8
}

$acceptedUserIDs = $detailRows | Where-Object { $_.TaskStatus -eq 'Accepted' -and $_.UserID } | ForEach-Object { $_.UserID } | Sort-Object -Unique
$nowUsers = Get-Date
$usersToResolve = New-Object System.Collections.Generic.List[object]
foreach ($uid in $acceptedUserIDs) {
    $key = [string]$uid
    $entry = $userCache[$key]
    $isFresh = $entry -and $entry.CachedAt -and ((New-TimeSpan -Start ([datetime]$entry.CachedAt) -End $nowUsers).TotalMinutes -lt $MaxUserCacheAgeMinutes)
    if (-not $isFresh) { $usersToResolve.Add($uid) }
}
Write-Host "$($acceptedUserIDs.Count) distinct reviewer(s) on Accepted tasks; $($usersToResolve.Count) need a fresh lookup ($($acceptedUserIDs.Count - $usersToResolve.Count) served from cache)."

$userLookupCount = 0
foreach ($uid in $usersToResolve) {
    $userLookupCount++
    if ($userLookupCount % 25 -eq 0 -or $userLookupCount -eq $usersToResolve.Count) {
        Write-Progress -Activity "Resolving reviewer names" -Status "$userLookupCount of $($usersToResolve.Count)" -PercentComplete (($userLookupCount / [Math]::Max($usersToResolve.Count,1)) * 100)
    }
    try {
        $u = Invoke-RestMethod -Uri "$BaseUrl/User/GetUser?userID=$uid" -Method Get -Headers $headers
        $name = Get-FirstPropertyValue $u @('FullName')
        if (-not $name) {
            $first = Get-FirstPropertyValue $u @('FirstName'); $last = Get-FirstPropertyValue $u @('LastName')
            $name = "$first $last".Trim()
        }
        if (-not $name) { $name = Get-FirstPropertyValue $u @('Email') }
        $userCache[[string]$uid] = [pscustomobject]@{ UserID = $uid; Name = $name; CachedAt = $nowUsers.ToString('o') }
    } catch {
        Write-Warning "User/GetUser($uid) failed: $($_.Exception.Message)"
    }
    if ($userLookupCount % 50 -eq 0) { Save-UserCache }
}
Write-Progress -Activity "Resolving reviewer names" -Completed
Save-UserCache
Write-Host "Reviewer name cache saved to $UserCacheJson ($($userCache.Count) total entries)."

foreach ($row in $detailRows) {
    if ($row.TaskStatus -eq 'Accepted' -and $row.UserID -and $userCache.ContainsKey([string]$row.UserID)) {
        $row.AssignedUserName = $userCache[[string]$row.UserID].Name
    }
}

$detailRows | Export-Csv -Path $DetailCsv -NoTypeInformation
Write-Host "`nDetail CSV written to $DetailCsv ($($detailRows.Count) rows)."

# --- Aggregate: (WorkflowTemplate, ReviewGroup) -> counts + accepted list --

$summary = $detailRows |
    Group-Object WorkflowTemplate, GroupName |
    ForEach-Object {
        $rows = $_.Group
        $accepted = @($rows | Where-Object { $_.TaskStatus -eq 'Accepted' })
        $pending = @($rows | Where-Object { $_.TaskStatus -eq 'Pending' })
        [pscustomobject]@{
            WorkflowTemplate = $rows[0].WorkflowTemplate
            GroupName        = $rows[0].GroupName
            OpenTaskCount    = $rows.Count
            PendingCount     = $pending.Count
            AcceptedCount    = $accepted.Count
            AcceptedBy       = @($accepted | Where-Object { $_.AssignedUserName } | ForEach-Object { "$($_.AssignedUserName) [$($_.ProjectName)]" })
        }
    } |
    Sort-Object WorkflowTemplate, GroupName

$snapshot = [pscustomobject]@{
    GeneratedAt    = (Get-Date).ToString("o")
    TotalOpenTasks = $detailRows.Count
    Groups         = $summary
}
$snapshot | ConvertTo-Json -Depth 6 | Out-File -FilePath $SnapshotJson -Encoding utf8
Write-Host "Dashboard snapshot written to $SnapshotJson"

Write-Host "`n================ WORKLOAD BY TEMPLATE / REVIEW GROUP ================"
$summary | Format-Table WorkflowTemplate, GroupName, OpenTaskCount, PendingCount, AcceptedCount -AutoSize
Write-Host "======================================================================="
Write-Host "Total run time: $($overallSw.Elapsed.TotalSeconds.ToString('N0'))s"
