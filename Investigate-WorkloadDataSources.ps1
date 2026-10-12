#requires -Version 5.1
<#
.SYNOPSIS
    Fast (<1 minute) probe of several possible shortcuts for building the
    review-workload dashboard, so we don't design the real collector blind.

.DESCRIPTION
    The interrupted run of Get-ProjectDoxReviewWorkload.ps1 got stuck paging
    ALL ~148,000 non-archived projects via GetManagedProjects just to find the
    handful of thousand that are "In Review" - that's the slow part, not the
    per-project workflow drill-down (which never even started). This script
    tests, with a small number of cheap calls, whether we can skip that
    full-project-list step entirely:

      Test A - WorkflowInstance/GetWorkflowInstancesByState
               Tries small state IDs (1..6) to see if any of them return
               running instances directly, without listing projects first.

      Test B - Query/QueryDatabase against INFORMATION_SCHEMA.TABLES/COLUMNS
               Checks whether the SA account can run ad-hoc SELECTs (which
               would let a single query replace the whole per-project crawl).
               A permission/validation error here is a useful, cheap answer
               ("no, don't go down this path") rather than a blocker.

      Test C - WorkflowAggregate/GetActiveWorkflowTaskList
               Checks whether this returns something useful with
               projectID/wflowActivityID omitted (i.e. "all active tasks").

      Test D - Timed 3-hop drill-down (WorkflowInstance/GetWorkflowInstancesByProjectName
               -> WorkflowActivityGroupingInstance/GetActivityGroupingInstances
               -> WorkflowReview/GetCurrentWorkflowReviews) for a couple of
               known "In Review" projects (pulled from your interrupted raw
               pull CSV), so we have a real seconds-per-project number instead
               of guessing.

    Everything is read-only. Results are printed to the console (raw JSON,
    truncated) and saved to Investigate-WorkloadDataSources-results.json so
    they can be reviewed/shared without re-running.

.PARAMETER BaseUrl
    Root of the ProjectDox Web API, no trailing slash.

.PARAMETER SampleProjectNames
    ProjectDox project Names known to currently be "In Review", used for
    Test D. Defaults to a few pulled from workload-raw-pull-20260919-190713.csv.
#>
[CmdletBinding()]
param(
    [string]$BaseUrl = "https://pompanobeach-fl-us-projectdoxwebapi.avolvecloud.com",

    [string[]]$SampleProjectNames = @("BP26-00006803", "BP26-00006799", "BP26-00006797")
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

function Invoke-Probe {
    param([string]$Label, [scriptblock]$Call)
    $result = [ordered]@{ Label = $Label; Success = $false; ElapsedMs = $null; Error = $null; Data = $null }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $data = & $Call
        $sw.Stop()
        $result.Success = $true
        $result.ElapsedMs = $sw.ElapsedMilliseconds
        $result.Data = $data
        Write-Host "`n--- $Label  (OK, $($sw.ElapsedMilliseconds) ms) ---" -ForegroundColor Green
    }
    catch {
        $sw.Stop()
        $result.ElapsedMs = $sw.ElapsedMilliseconds
        $result.Error = $_.Exception.Message
        $body = $null
        if ($_.Exception.Response) {
            try {
                $stream = $_.Exception.Response.GetResponseStream()
                $reader = New-Object System.IO.StreamReader($stream)
                $body = $reader.ReadToEnd()
            } catch {}
        }
        if ($body) { $result.Error = "$($result.Error) | Body: $body" }
        Write-Host "`n--- $Label  (FAILED, $($sw.ElapsedMilliseconds) ms) ---" -ForegroundColor Red
        Write-Host $result.Error -ForegroundColor Yellow
    }

    if ($result.Success) {
        $preview = ($result.Data | ConvertTo-Json -Depth 6 -Compress)
        if ($preview.Length -gt 1500) { $preview = $preview.Substring(0, 1500) + " ...(truncated)" }
        Write-Host $preview
    }
    return [pscustomobject]$result
}

Write-Host "Logging into ProjectDox at $BaseUrl ..."
$sessionId = Connect-ProjectDox -BaseUrl $BaseUrl
$headers = @{ SessionID = $sessionId }
Write-Host "Logged in.`n"

$results = New-Object System.Collections.Generic.List[object]

# --- Test A: GetWorkflowInstancesByState for small state IDs ---------------
foreach ($stateId in 1..6) {
    $results.Add((Invoke-Probe -Label "A.$stateId GetWorkflowInstancesByState(stateId=$stateId)" -Call {
        Invoke-RestMethod -Uri "$BaseUrl/WorkflowInstance/GetWorkflowInstancesByState?wflowInstanceStateID=$stateId&startIndex=0&rowCount=3" -Method Get -Headers $headers
    }))
}

# --- Test B: Query/QueryDatabase ad-hoc SELECT capability -------------------
$results.Add((Invoke-Probe -Label "B.1 QueryDatabase INFORMATION_SCHEMA.TABLES" -Call {
    $body = @{
        IsProjectDox     = $true
        ConnectionString = $null
        Operation        = "select"
        TableName        = "INFORMATION_SCHEMA.TABLES"
    } | ConvertTo-Json
    Invoke-RestMethod -Uri "$BaseUrl/Query/QueryDatabase" -Method Post -Headers $headers -ContentType "application/json" -Body $body
}))

$results.Add((Invoke-Probe -Label "B.2 QueryDatabase literal table (WFlowReviews)" -Call {
    $body = @{
        IsProjectDox     = $true
        ConnectionString = $null
        Operation        = "select"
        TableName        = "WFlowReviews"
    } | ConvertTo-Json
    Invoke-RestMethod -Uri "$BaseUrl/Query/QueryDatabase" -Method Post -Headers $headers -ContentType "application/json" -Body $body
}))

# --- Test C: WorkflowAggregate/GetActiveWorkflowTaskList with no filters ---
$results.Add((Invoke-Probe -Label "C.1 GetActiveWorkflowTaskList (no filters, showTasksForAllUsers=true)" -Call {
    Invoke-RestMethod -Uri "$BaseUrl/WorkflowAggregate/GetActiveWorkflowTaskList?showTasksForAllUsers=true" -Method Get -Headers $headers
}))

# --- Test D: timed 3-hop drill-down for a couple of known in-review projects
foreach ($projectName in $SampleProjectNames) {
    $probe = Invoke-Probe -Label "D.1 GetWorkflowInstancesByProjectName($projectName)" -Call {
        Invoke-RestMethod -Uri "$BaseUrl/WorkflowInstance/GetWorkflowInstancesByProjectName?projectName=$([uri]::EscapeDataString($projectName))" -Method Get -Headers $headers
    }
    $results.Add($probe)

    if ($probe.Success) {
        $instances = @($probe.Data)
        $inst = $instances | Select-Object -Last 1
        $wflowInstanceID = ($inst.PSObject.Properties | Where-Object { $_.Name -imatch 'WFlowInstanceID|InstanceID' } | Select-Object -First 1).Value

        if ($wflowInstanceID) {
            $groupingProbe = Invoke-Probe -Label "D.2 GetActivityGroupingInstances(wflowInstanceID=$wflowInstanceID) for $projectName" -Call {
                Invoke-RestMethod -Uri "$BaseUrl/WorkflowActivityGroupingInstance/GetActivityGroupingInstances?wflowInstanceID=$wflowInstanceID&hasReviewActivity=true&determineActive=true" -Method Get -Headers $headers
            }
            $results.Add($groupingProbe)

            if ($groupingProbe.Success) {
                $groupings = @($groupingProbe.Data)
                $grp = $groupings | Select-Object -Last 1
                $groupingInstanceID = ($grp.PSObject.Properties | Where-Object { $_.Name -imatch 'GroupingInstanceID' } | Select-Object -First 1).Value

                if ($groupingInstanceID) {
                    $reviewProbe = Invoke-Probe -Label "D.3 GetCurrentWorkflowReviews(wflowInstanceID=$wflowInstanceID, groupingInstanceID=$groupingInstanceID) for $projectName" -Call {
                        Invoke-RestMethod -Uri "$BaseUrl/WorkflowReview/GetCurrentWorkflowReviews?wflowInstanceID=$wflowInstanceID&wflowActivityGroupingInstanceID=$groupingInstanceID" -Method Get -Headers $headers
                    }
                    $results.Add($reviewProbe)
                }
            }
        }
    }
}

$outFile = Join-Path $PSScriptRoot "Investigate-WorkloadDataSources-results.json"
$results | ConvertTo-Json -Depth 8 | Out-File -FilePath $outFile -Encoding utf8
Write-Host "`n`nFull results (untruncated) saved to $outFile"

Write-Host "`n================ SUMMARY ================"
$results | ForEach-Object {
    $status = if ($_.Success) { "OK  " } else { "FAIL" }
    Write-Host ("[{0}] {1,-70} {2,6} ms" -f $status, $_.Label, $_.ElapsedMs)
}
Write-Host "==========================================="
