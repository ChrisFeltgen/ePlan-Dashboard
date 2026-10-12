#requires -Version 5.1
<#
.SYNOPSIS
    Round 2 of data-source discovery. Round 1 (Investigate-WorkloadDataSources.ps1)
    proved Query/QueryDatabase can pull whole application tables fast (WFlowReviews,
    9.3MB, in ~2s) and that INFORMATION_SCHEMA is queryable. Its table list turned
    up several purpose-built reporting views that look like exactly what this
    dashboard needs:

        ReportViewReviewGroupStats, ReportViewDeptReviews, vw_TaskList,
        ReportViewActiveProjectsInfo, ReportViewTasks

    This script pulls a sample of each of those, plus the small lookup tables
    that decode status/state IDs (WFlowInstanceStates, WFlowReviewStatusTypes,
    WFlowTaskStatusTypes, ProjectStatus), plus the column list (from
    INFORMATION_SCHEMA.COLUMNS) for every candidate table/view so we can see
    real column names without guessing.

    It also tests whether QueryDatabase's UpdateClause parameter can filter a
    "select" server-side (tried against Projects, filtering to Status='In Review')
    - if that works, later refreshes can pull only what's needed instead of
    whole tables every time.

    Each table/view's result is saved to its own JSON file
    (workload-probe-<TableName>.json) so nothing blows past size limits, and a
    compact summary (row count + column names) is printed to the console.

.PARAMETER BaseUrl
    Root of the ProjectDox Web API, no trailing slash.
#>
[CmdletBinding()]
param(
    [string]$BaseUrl = "https://pompanobeach-fl-us-projectdoxwebapi.avolvecloud.com"
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Connect-ProjectDox {
    param([string]$BaseUrl)
    $cred = Get-Credential -Message "ProjectDox account (must be a System Administrator)"
    $body = @{ Email = $cred.UserName; Password = $cred.GetNetworkCredential().Password } | ConvertTo-Json
    $response = Invoke-RestMethod -Uri "$BaseUrl/User/Login" -Method Post -ContentType "application/json" -Body $body
    $sessionId = $response.SessionID
    if (-not $sessionId) { throw "No SessionID in login response: $($response | ConvertTo-Json -Compress)" }
    return $sessionId
}

function Invoke-QueryDatabase {
    param([string]$BaseUrl, [hashtable]$Headers, [string]$TableName, [string]$UpdateClause)

    $payload = [ordered]@{
        IsProjectDox     = $true
        ConnectionString = $null
        Operation        = "select"
        TableName        = $TableName
    }
    if ($UpdateClause) { $payload.UpdateClause = $UpdateClause }

    Invoke-RestMethod -Uri "$BaseUrl/Query/QueryDatabase" -Method Post -Headers $Headers `
        -ContentType "application/json" -Body ($payload | ConvertTo-Json)
}

function Get-Rows {
    param($RawResult, [string]$TableName)
    # QueryDatabase appears to wrap rows under a property named after the table.
    $prop = $RawResult.PSObject.Properties | Where-Object { $_.Name -ieq $TableName } | Select-Object -First 1
    if ($prop) { return @($prop.Value) }
    # Fall back: if it's already an array-like or has a single property, use that.
    if ($RawResult -is [System.Collections.IEnumerable] -and -not ($RawResult -is [string])) { return @($RawResult) }
    $firstProp = $RawResult.PSObject.Properties | Select-Object -First 1
    if ($firstProp) { return @($firstProp.Value) }
    return @()
}

function Probe-Table {
    param([string]$BaseUrl, [hashtable]$Headers, [string]$TableName, [string]$UpdateClause, [int]$PreviewRows = 2)

    Write-Host "`n--- $TableName $(if ($UpdateClause) { "(filtered: $UpdateClause)" }) ---" -ForegroundColor Cyan
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $raw = Invoke-QueryDatabase -BaseUrl $BaseUrl -Headers $Headers -TableName $TableName -UpdateClause $UpdateClause
        $sw.Stop()
        $rows = Get-Rows -RawResult $raw -TableName $TableName

        $outFile = Join-Path $PSScriptRoot "workload-probe-$($TableName -replace '[^\w]','_').json"
        $rows | ConvertTo-Json -Depth 8 | Out-File -FilePath $outFile -Encoding utf8

        $cols = if ($rows.Count -gt 0) { $rows[0].PSObject.Properties.Name -join ', ' } else { '(no rows)' }
        Write-Host ("OK  {0,6} ms  {1,7} rows  -> {2}" -f $sw.ElapsedMilliseconds, $rows.Count, (Split-Path $outFile -Leaf)) -ForegroundColor Green
        Write-Host "Columns: $cols"
        if ($rows.Count -gt 0) {
            Write-Host "Preview:"
            $rows | Select-Object -First $PreviewRows | ConvertTo-Json -Depth 4 -Compress | Write-Host
        }
        return [pscustomobject]@{ TableName = $TableName; Success = $true; RowCount = $rows.Count; ElapsedMs = $sw.ElapsedMilliseconds; Columns = $cols; File = (Split-Path $outFile -Leaf) }
    }
    catch {
        $sw.Stop()
        $msg = $_.Exception.Message
        if ($_.Exception.Response) {
            try {
                $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $msg = "$msg | Body: $($reader.ReadToEnd())"
            } catch {}
        }
        Write-Host "FAIL $($sw.ElapsedMilliseconds) ms  $msg" -ForegroundColor Red
        return [pscustomobject]@{ TableName = $TableName; Success = $false; RowCount = 0; ElapsedMs = $sw.ElapsedMilliseconds; Columns = $msg; File = $null }
    }
}

Write-Host "Logging into ProjectDox at $BaseUrl ..."
$sessionId = Connect-ProjectDox -BaseUrl $BaseUrl
$headers = @{ SessionID = $sessionId }
Write-Host "Logged in.`n"

$summary = New-Object System.Collections.Generic.List[object]

# --- Column lists for every candidate table/view, one shot -----------------
Write-Host "=== INFORMATION_SCHEMA.COLUMNS for candidate tables ===" -ForegroundColor Magenta
$candidateTables = @(
    'WFlowInstanceStates','WFlowReviewStatusTypes','WFlowTaskStatusTypes','ProjectStatus',
    'ReportViewReviewGroupStats','ReportViewDeptReviews','vw_TaskList',
    'ReportViewActiveProjectsInfo','ReportViewTasks',
    'Groups','Users','Projects','ProjectTemplates','WFlows','WFlowVersions','WFlowInstances'
)
try {
    $colsRaw = Invoke-QueryDatabase -BaseUrl $BaseUrl -Headers $headers -TableName "INFORMATION_SCHEMA.COLUMNS"
    $colsRows = Get-Rows -RawResult $colsRaw -TableName "INFORMATION_SCHEMA.COLUMNS"
    $colsRows | ConvertTo-Json -Depth 4 | Out-File -FilePath (Join-Path $PSScriptRoot "workload-probe-columns.json") -Encoding utf8
    foreach ($t in $candidateTables) {
        $cols = ($colsRows | Where-Object { $_.TABLE_NAME -ieq $t } | Sort-Object ORDINAL_POSITION | ForEach-Object { $_.COLUMN_NAME }) -join ', '
        Write-Host "$t : $cols"
    }
}
catch {
    Write-Warning "INFORMATION_SCHEMA.COLUMNS pull failed: $($_.Exception.Message)"
}

# --- Small lookup tables (pull in full) -------------------------------------
Write-Host "`n=== Lookup tables ===" -ForegroundColor Magenta
foreach ($t in @('WFlowInstanceStates','WFlowReviewStatusTypes','WFlowTaskStatusTypes','ProjectStatus')) {
    $summary.Add((Probe-Table -BaseUrl $BaseUrl -Headers $headers -TableName $t -PreviewRows 20))
}

# --- Candidate reporting views ----------------------------------------------
Write-Host "`n=== Reporting views ===" -ForegroundColor Magenta
foreach ($t in @('ReportViewReviewGroupStats','ReportViewDeptReviews','vw_TaskList','ReportViewActiveProjectsInfo','ReportViewTasks')) {
    $summary.Add((Probe-Table -BaseUrl $BaseUrl -Headers $headers -TableName $t -PreviewRows 2))
}

# --- ReportView_GetWorkflowTasks: confirmed by the "Management - Task Workload"
# RDL to be the exact source the official Task Workload report uses. Its own
# WHERE clause is: TaskStatus IN ('Accepted','Pending') AND WorkflowStatus
# NOT IN ('Completed'). Probe it unfiltered (to see real size/speed) AND with
# an UpdateClause matching that filter (to see whether QueryDatabase can push
# an arbitrary boolean WHERE server-side, which would cut payload size a lot).
Write-Host "`n=== ReportView_GetWorkflowTasks (the Task Workload report's real source) ===" -ForegroundColor Magenta
$summary.Add((Probe-Table -BaseUrl $BaseUrl -Headers $headers -TableName 'ReportView_GetWorkflowTasks' -PreviewRows 3))
$summary.Add((Probe-Table -BaseUrl $BaseUrl -Headers $headers -TableName 'ReportView_GetWorkflowTasks' `
    -UpdateClause "TaskStatus IN ('Accepted','Pending') AND WorkflowStatus NOT IN ('Completed')" -PreviewRows 3))

# --- Reference tables needed to label templates/groups ----------------------
Write-Host "`n=== Reference tables ===" -ForegroundColor Magenta
foreach ($t in @('ProjectTemplates','WFlows','Groups')) {
    $summary.Add((Probe-Table -BaseUrl $BaseUrl -Headers $headers -TableName $t -PreviewRows 2))
}

# --- Test whether UpdateClause filters a select server-side -----------------
Write-Host "`n=== Server-side filter test (Projects, Status='In Review') ===" -ForegroundColor Magenta
$summary.Add((Probe-Table -BaseUrl $BaseUrl -Headers $headers -TableName 'Projects' -UpdateClause "Status='In Review'" -PreviewRows 2))

Write-Host "`n================ SUMMARY ================"
$summary | Format-Table TableName, Success, RowCount, ElapsedMs, File -AutoSize
Write-Host "==========================================="
Write-Host "`nAll raw results saved as workload-probe-*.json next to this script."
