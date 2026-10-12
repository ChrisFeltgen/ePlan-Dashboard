#requires -Version 5.1
<#
.SYNOPSIS
    Current department-review workload dashboard: for every project currently
    in active review, shows how many open review tasks each review group has
    (broken down by project template/workflow), and flags any task a specific
    reviewer has already Accepted (vs. still sitting Pending with the group).

.DESCRIPTION
    Uses the ProjectDox REST Web API:
      - POST /User/Login                                  (auth, returns SessionID)
      - GET  /Project/GetManagedProjects                   (paged project list, same
                                                              proven pattern as
                                                              Update-ProjectDoxPagerPhone.ps1)
      - GET  /WorkflowInstance/GetWorkflowInstancesByProjectName
      - GET  /WorkflowActivityGroupingInstance/GetActivityGroupingInstances
      - GET  /WorkflowReview/GetCurrentWorkflowReviews

    For each project whose Status is one of -ReviewStatuses (default "In Review"),
    the script walks: Project -> active WorkflowInstance -> active review
    ActivityGroupingInstance -> current WorkflowReviews (one record per review
    group for the current review cycle). It rolls the results up by
    (WorkflowTemplate, ReviewGroup) into a count of open tasks, and separately
    flags/lists any review that has been Accepted by a specific person.

    IMPORTANT - this drills into 3 undocumented response shapes (workflow
    instance, activity grouping instance, workflow review). The property
    names below (GroupName/Status/UserName etc.) are best guesses based on
    the API's naming conventions elsewhere and are extracted defensively
    (several candidate names are tried). Run with -Diagnose first against a
    small sample and eyeball the raw JSON dump before trusting the numbers -
    exactly like -Diagnose was used to validate GetManagedProjects paging in
    Update-ProjectDoxPagerPhone.ps1.

.PARAMETER BaseUrl
    Root of the ProjectDox Web API, no trailing slash.

.PARAMETER ReviewStatuses
    Project Status value(s) (exact text as stored in ProjectDox) that count as
    "currently in department review". Default: "In Review".

.PARAMETER FromRawPullCsv
    Reuse a previously saved raw project pull (e.g. from
    Update-ProjectDoxPagerPhone.ps1's -RawPullCsv output, or this script's own
    -RawPullCsv) instead of re-paging GetManagedProjects. Must have
    ProjectID, Name and Status columns. A live login still happens (the
    workflow/review drill-down always needs a real session).

.PARAMETER RawPullCsv
    Where a freshly paged project list is saved, page by page, when
    -FromRawPullCsv is not used. Defaults to a timestamped file next to the
    script.

.PARAMETER PageSize
    Rows per GetManagedProjects request when paging fresh. Default 500.

.PARAMETER MaxPages
    Safety cap on pages fetched when paging fresh. Default 1000.

.PARAMETER SampleSize
    If set, only process the first N in-review projects through the
    workflow/review drill-down. Use this for a quick trial run (and with
    -Diagnose) before committing to the full crawl, which can be slow since
    it's 2-3 API calls per in-review project.

.PARAMETER Diagnose
    For the first few projects processed (see -DiagnoseCount), print the raw
    JSON returned at each hop (workflow instance, activity grouping instance,
    workflow reviews) so the property-name guesses can be verified/corrected.

.PARAMETER DiagnoseCount
    How many projects to dump raw JSON for for when -Diagnose is set. Default 3.

.PARAMETER DetailCsv
    Path for the per-review detail rows (one row per review-group task found).
    Defaults to a timestamped file next to the script.

.PARAMETER SummaryCsv
    Path for the rolled-up (Template, ReviewGroup) summary. Defaults to a
    timestamped file next to the script.

.EXAMPLE
    # Cheap trial run: only the first 3 in-review projects, with raw JSON dumps
    .\Get-ProjectDoxReviewWorkload.ps1 -SampleSize 3 -Diagnose

.EXAMPLE
    # Reuse today's already-pulled project list instead of re-paging ~150k rows
    .\Get-ProjectDoxReviewWorkload.ps1 -FromRawPullCsv .\projectdox-raw-pull-20260915-230752.csv

.EXAMPLE
    # Full run against specific statuses
    .\Get-ProjectDoxReviewWorkload.ps1 -ReviewStatuses "In Review","Contractor Updates Required"
#>
[CmdletBinding()]
param(
    [string]$BaseUrl = "https://pompanobeach-fl-us-projectdoxwebapi.avolvecloud.com",

    [string[]]$ReviewStatuses = @("In Review"),

    [string]$FromRawPullCsv,

    [string]$RawPullCsv = (Join-Path $PSScriptRoot "workload-raw-pull-$(Get-Date -Format 'yyyyMMdd-HHmmss').csv"),

    [int]$PageSize = 500,

    [int]$MaxPages = 1000,

    [int]$SampleSize = 0,

    [switch]$Diagnose,

    [int]$DiagnoseCount = 3,

    [string]$DetailCsv = (Join-Path $PSScriptRoot "workload-detail-$(Get-Date -Format 'yyyyMMdd-HHmmss').csv"),

    [string]$SummaryCsv = (Join-Path $PSScriptRoot "workload-summary-$(Get-Date -Format 'yyyyMMdd-HHmmss').csv")
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---------------------------------------------------------------------------
# Auth / project listing (same proven pattern as Update-ProjectDoxPagerPhone.ps1)
# ---------------------------------------------------------------------------

function Connect-ProjectDox {
    param([string]$BaseUrl)

    $cred = Get-Credential -Message "ProjectDox account (must be a System/Project Administrator)"
    $plainPassword = $cred.GetNetworkCredential().Password

    $body = @{
        Email    = $cred.UserName
        Password = $plainPassword
    } | ConvertTo-Json

    $response = Invoke-RestMethod -Uri "$BaseUrl/User/Login" -Method Post `
        -ContentType "application/json" -Body $body

    $sessionId = $null
    if ($response -is [System.Collections.IDictionary]) {
        $sessionId = $response['SessionID']
    }
    if (-not $sessionId) {
        $prop = $response.PSObject.Properties | Where-Object { $_.Name -match '^SessionID$' } | Select-Object -First 1
        if ($prop) { $sessionId = $prop.Value }
    }

    if (-not $sessionId) {
        throw "Login succeeded but no SessionID was found in the response: $($response | ConvertTo-Json -Compress)"
    }

    return $sessionId
}

function Get-AllProjectDoxProjects {
    param(
        [string]$BaseUrl,
        [hashtable]$Headers,
        [int]$PageSize = 500,
        [int]$MaxPages = 1000,
        [string]$CacheCsv
    )

    $pageIndex = 0
    $totalRows = [int]::MaxValue
    $all = New-Object System.Collections.Generic.List[object]
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    do {
        $uri = "$BaseUrl/Project/GetManagedProjects?viewArchivedOnly=false&PageIndex=$pageIndex&PageSize=$PageSize&StartIndex=$($pageIndex * $PageSize)"
        $pageSw = [System.Diagnostics.Stopwatch]::StartNew()
        $page = Invoke-RestMethod -Uri $uri -Method Get -Headers $Headers
        $pageSw.Stop()

        if (-not $page.Items -or $page.Items.Count -eq 0) { break }

        foreach ($p in $page.Items) {
            $all.Add([pscustomobject]@{
                ProjectID = $p.ProjectID
                Name      = $p.Name
                Status    = $p.Status
            })
        }

        $totalRows = [int]$page.TotalRowsCount
        $etaSec = if ($pageSw.Elapsed.TotalSeconds -gt 0 -and $totalRows -gt 0) {
            (($totalRows - $all.Count) / $PageSize) * $pageSw.Elapsed.TotalSeconds
        } else { 0 }
        Write-Host ("  page {0}: +{1} rows ({2} of {3}) in {4:N1}s [{5:N0}s elapsed, ~{6:N0}s remaining]" -f `
            $pageIndex, $page.Items.Count, $all.Count, $totalRows, $pageSw.Elapsed.TotalSeconds, $sw.Elapsed.TotalSeconds, $etaSec)
        $pageIndex++

        if ($CacheCsv) {
            $all | Export-Csv -Path $CacheCsv -NoTypeInformation
        }

        if ($pageIndex -gt $MaxPages) {
            Write-Warning "Stopped after $MaxPages pages as a safety cap."
            break
        }
    } while ($all.Count -lt $totalRows)

    Write-Host "  GetManagedProjects reported TotalRowsCount = $totalRows; retrieved $($all.Count) in $($sw.Elapsed.TotalSeconds.ToString('N0'))s."
    return $all
}

# ---------------------------------------------------------------------------
# Defensive property extraction - the workflow/review endpoints' JSON shapes
# aren't documented, so try several plausible names per logical field.
# ---------------------------------------------------------------------------

function Get-FirstPropertyValue {
    param(
        [Parameter(Mandatory)] $Object,
        [Parameter(Mandatory)] [string[]]$CandidateNames
    )

    if ($null -eq $Object) { return $null }

    foreach ($name in $CandidateNames) {
        $prop = $Object.PSObject.Properties | Where-Object { $_.Name -ieq $name } | Select-Object -First 1
        if ($prop -and $null -ne $prop.Value -and $prop.Value -ne '') { return $prop.Value }
    }
    # Fall back to a fuzzy (contains) match on the first candidate's root word
    foreach ($name in $CandidateNames) {
        $prop = $Object.PSObject.Properties | Where-Object { $_.Name -imatch [regex]::Escape($name) } | Select-Object -First 1
        if ($prop -and $null -ne $prop.Value -and $prop.Value -ne '') { return $prop.Value }
    }
    return $null
}

function ConvertTo-ObjectArray {
    param($Value)
    if ($null -eq $Value) { return @() }
    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) { return @($Value) }
    return @($Value)
}

# ---------------------------------------------------------------------------
# Workflow drill-down
# ---------------------------------------------------------------------------

function Get-ActiveWorkflowInstance {
    param([string]$BaseUrl, [hashtable]$Headers, [string]$ProjectName)

    $uri = "$BaseUrl/WorkflowInstance/GetWorkflowInstancesByProjectName?projectName=$([uri]::EscapeDataString($ProjectName))"
    $result = Invoke-RestMethod -Uri $uri -Method Get -Headers $Headers
    $instances = ConvertTo-ObjectArray $result
    if ($instances.Count -eq 0) { return $null }

    # Prefer an instance whose state doesn't look terminal; otherwise take the
    # last (presumably most recent) one returned.
    $terminalPattern = 'Complet|Terminat|Error|Void|Cancel'
    $active = $instances | Where-Object {
        $state = Get-FirstPropertyValue $_ @('WFlowInstanceStateName','InstanceStateName','State','StateName','Status')
        -not ($state -and $state -imatch $terminalPattern)
    }
    if ($active) { return ($active | Select-Object -Last 1) }
    return ($instances | Select-Object -Last 1)
}

function Get-ActiveReviewGroupingInstance {
    param([string]$BaseUrl, [hashtable]$Headers, [string]$WflowInstanceID)

    $uri = "$BaseUrl/WorkflowActivityGroupingInstance/GetActivityGroupingInstances?wflowInstanceID=$WflowInstanceID&hasReviewActivity=true&determineActive=true"
    $result = Invoke-RestMethod -Uri $uri -Method Get -Headers $Headers
    $groupings = ConvertTo-ObjectArray $result
    if ($groupings.Count -eq 0) { return $null }
    return ($groupings | Select-Object -Last 1)
}

function Get-CurrentWorkflowReviews {
    param([string]$BaseUrl, [hashtable]$Headers, [string]$WflowInstanceID, [string]$GroupingInstanceID)

    $uri = "$BaseUrl/WorkflowReview/GetCurrentWorkflowReviews?wflowInstanceID=$WflowInstanceID&wflowActivityGroupingInstanceID=$GroupingInstanceID"
    $result = Invoke-RestMethod -Uri $uri -Method Get -Headers $Headers
    return ConvertTo-ObjectArray $result
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

Write-Host "Logging into ProjectDox at $BaseUrl ..."
$sessionId = Connect-ProjectDox -BaseUrl $BaseUrl
$headers = @{ SessionID = $sessionId }
Write-Host "Logged in. Session established."

if ($FromRawPullCsv) {
    Write-Host "Loading previously pulled project list from $FromRawPullCsv ..."
    $allProjects = Import-Csv -Path $FromRawPullCsv
    Write-Host "Loaded $($allProjects.Count) projects from cache (no listing API calls made)."
}
else {
    Write-Host "Fetching all non-archived projects (paged, saving progress to $RawPullCsv) ..."
    $allProjects = Get-AllProjectDoxProjects -BaseUrl $BaseUrl -Headers $headers -PageSize $PageSize -MaxPages $MaxPages -CacheCsv $RawPullCsv
    Write-Host "Retrieved $($allProjects.Count) projects total. Raw pull saved to $RawPullCsv"
}

$inReview = $allProjects | Where-Object { $_.Status -and $ReviewStatuses -contains $_.Status }
Write-Host "`n$($inReview.Count) project(s) match ReviewStatuses [$($ReviewStatuses -join ', ')]."

if ($SampleSize -gt 0 -and $inReview.Count -gt $SampleSize) {
    Write-Host "Limiting to first -SampleSize $SampleSize project(s) for this run."
    $inReview = $inReview | Select-Object -First $SampleSize
}

if (-not $inReview) {
    Write-Host "Nothing to do."
    return
}

$detailRows = New-Object System.Collections.Generic.List[object]
$diagnosedCount = 0
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$i = 0

foreach ($project in $inReview) {
    $i++
    $doDiagnose = $Diagnose -and ($diagnosedCount -lt $DiagnoseCount)

    Write-Progress -Activity "Walking review workflow" -Status "$($project.Name) ($i of $($inReview.Count))" -PercentComplete (($i / $inReview.Count) * 100)

    try {
        $instance = Get-ActiveWorkflowInstance -BaseUrl $BaseUrl -Headers $headers -ProjectName $project.Name

        if ($doDiagnose) {
            Write-Host "`n=== DIAGNOSE: $($project.Name) (ProjectID $($project.ProjectID)) ===" -ForegroundColor Cyan
            Write-Host "-- WorkflowInstance --"
            $instance | ConvertTo-Json -Depth 6 | Write-Host
        }

        if (-not $instance) {
            $detailRows.Add([pscustomobject]@{
                ProjectID = $project.ProjectID; ProjectName = $project.Name; ProjectStatus = $project.Status
                WorkflowName = $null; WflowInstanceID = $null; GroupName = $null
                ReviewStatus = $null; Accepted = $false; AssignedUser = $null
                Note = "No workflow instance found via GetWorkflowInstancesByProjectName"
            })
            continue
        }

        $wflowInstanceID = Get-FirstPropertyValue $instance @('WFlowInstanceID','WflowInstanceID','InstanceID')
        $workflowName    = Get-FirstPropertyValue $instance @('WFlowName','WorkflowName','TemplateName','Name')

        $grouping = Get-ActiveReviewGroupingInstance -BaseUrl $BaseUrl -Headers $headers -WflowInstanceID $wflowInstanceID

        if ($doDiagnose) {
            Write-Host "-- ActivityGroupingInstance --"
            $grouping | ConvertTo-Json -Depth 6 | Write-Host
        }

        if (-not $grouping) {
            $detailRows.Add([pscustomobject]@{
                ProjectID = $project.ProjectID; ProjectName = $project.Name; ProjectStatus = $project.Status
                WorkflowName = $workflowName; WflowInstanceID = $wflowInstanceID; GroupName = $null
                ReviewStatus = $null; Accepted = $false; AssignedUser = $null
                Note = "No active review ActivityGroupingInstance found"
            })
            continue
        }

        $groupingInstanceID = Get-FirstPropertyValue $grouping @('WFlowActivityGroupingInstanceID','ActivityGroupingInstanceID','GroupingInstanceID')

        $reviews = Get-CurrentWorkflowReviews -BaseUrl $BaseUrl -Headers $headers -WflowInstanceID $wflowInstanceID -GroupingInstanceID $groupingInstanceID

        if ($doDiagnose) {
            Write-Host "-- CurrentWorkflowReviews ($($reviews.Count) record(s)) --"
            $reviews | ConvertTo-Json -Depth 6 | Write-Host
            $diagnosedCount++
        }

        if (-not $reviews -or $reviews.Count -eq 0) {
            $detailRows.Add([pscustomobject]@{
                ProjectID = $project.ProjectID; ProjectName = $project.Name; ProjectStatus = $project.Status
                WorkflowName = $workflowName; WflowInstanceID = $wflowInstanceID; GroupName = $null
                ReviewStatus = $null; Accepted = $false; AssignedUser = $null
                Note = "Active grouping instance had no current reviews"
            })
            continue
        }

        foreach ($review in $reviews) {
            $groupName    = Get-FirstPropertyValue $review @('GroupName','ReviewGroupName','Group')
            $reviewStatus = Get-FirstPropertyValue $review @('ReviewStatusName','StatusName','ReviewStatus','Status','TaskStatus')
            $assignedUser = Get-FirstPropertyValue $review @('UserName','AssignedUserName','ReviewerName','FullName','UserFullName')
            $accepted     = [bool]($reviewStatus -and $reviewStatus -imatch 'Accept')

            $detailRows.Add([pscustomobject]@{
                ProjectID = $project.ProjectID; ProjectName = $project.Name; ProjectStatus = $project.Status
                WorkflowName = $workflowName; WflowInstanceID = $wflowInstanceID; GroupName = $groupName
                ReviewStatus = $reviewStatus; Accepted = $accepted; AssignedUser = $assignedUser
                Note = $null
            })
        }
    }
    catch {
        Write-Warning "Project $($project.Name) (ID $($project.ProjectID)): $($_.Exception.Message)"
        $detailRows.Add([pscustomobject]@{
            ProjectID = $project.ProjectID; ProjectName = $project.Name; ProjectStatus = $project.Status
            WorkflowName = $null; WflowInstanceID = $null; GroupName = $null
            ReviewStatus = $null; Accepted = $false; AssignedUser = $null
            Note = "ERROR: $($_.Exception.Message)"
        })
    }

    # Save progress periodically so a long run can be interrupted safely.
    if ($i % 50 -eq 0) {
        $detailRows | Export-Csv -Path $DetailCsv -NoTypeInformation
    }
}
Write-Progress -Activity "Walking review workflow" -Completed

$detailRows | Export-Csv -Path $DetailCsv -NoTypeInformation
Write-Host "`nDetail rows written to $DetailCsv ($($detailRows.Count) rows) in $($sw.Elapsed.TotalSeconds.ToString('N0'))s."

# ---------------------------------------------------------------------------
# Rollup: (WorkflowTemplate, ReviewGroup) -> open task count + accepted flag
# ---------------------------------------------------------------------------

$withGroup = $detailRows | Where-Object { $_.GroupName }

$summary = $withGroup |
    Group-Object WorkflowName, GroupName |
    ForEach-Object {
        $rows = $_.Group
        $accepted = $rows | Where-Object { $_.Accepted }
        [pscustomobject]@{
            WorkflowName  = $rows[0].WorkflowName
            GroupName     = $rows[0].GroupName
            OpenTaskCount = $rows.Count
            AcceptedCount = $accepted.Count
            AcceptedBy    = ($accepted | ForEach-Object { "$($_.AssignedUser) [$($_.ProjectName)]" }) -join '; '
        }
    } |
    Sort-Object WorkflowName, GroupName

$summary | Export-Csv -Path $SummaryCsv -NoTypeInformation
Write-Host "Summary written to $SummaryCsv"

Write-Host "`n================ WORKLOAD BY TEMPLATE / REVIEW GROUP ================"
$summary | Format-Table WorkflowName, GroupName, OpenTaskCount, AcceptedCount -AutoSize

$noGroup = $detailRows | Where-Object { -not $_.GroupName }
if ($noGroup.Count -gt 0) {
    Write-Host "`n$($noGroup.Count) project(s) produced no group-level review data (see Note column in $DetailCsv) - the drill-down chain may need adjusting for those workflows/statuses."
}
Write-Host "======================================================================="
