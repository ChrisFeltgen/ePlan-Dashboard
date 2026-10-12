#requires -Version 5.1
<#
.SYNOPSIS
    Registers (or re-registers) a Windows scheduled task that runs
    Get-WorkloadSnapshot.ps1 on a repeating interval, refreshing
    workload-snapshot.json for the dashboard page to read.

.DESCRIPTION
    Run this ONCE, as Administrator, on whatever machine will host the
    refresh job (it doesn't need to be the same machine as IIS - the
    dashboard just needs to read workload-snapshot.json over the network or
    have it copied/synced to the IIS folder).

    Before running this, set PROJECTDOX_ADMIN_EMAIL and PROJECTDOX_ADMIN_PASSWORD
    as PERSISTENT environment variables on the account the task will run as
    (System Properties > Environment Variables, or the -SetEnvVars switch
    below), so Get-WorkloadSnapshot.ps1's non-interactive login path kicks in.
    Without them, the task will silently hang at the Get-Credential prompt
    with no one there to answer it.

.PARAMETER TaskName
    Name for the scheduled task.

.PARAMETER IntervalMinutes
    How often to refresh. 15-30 minutes is reasonable for a workload
    dashboard; each run costs a couple of bulk table pulls plus REST lookups
    for any NEWLY-seen workflow instances (most will already be cached from
    the previous run, so steady-state runs should be fast).

.PARAMETER RunAsUser
    Account the task runs as. Defaults to the current user. For an unattended
    service account, pass its domain\username and you'll be prompted for its
    Windows password separately (this is the Windows logon password, NOT the
    ProjectDox one - those are set via PROJECTDOX_ADMIN_EMAIL/PASSWORD).

.PARAMETER SetEnvVars
    If passed, also sets PROJECTDOX_ADMIN_EMAIL/PROJECTDOX_ADMIN_PASSWORD as
    persistent machine-level environment variables right now, prompting for
    them securely. Skip this if you've already set them yourself.

.EXAMPLE
    .\Register-WorkloadScheduledTask.ps1 -SetEnvVars -IntervalMinutes 20
#>
[CmdletBinding()]
param(
    [string]$TaskName = "ProjectDox Review Workload Snapshot",

    [int]$IntervalMinutes = 20,

    [string]$RunAsUser = "$env:USERDOMAIN\$env:USERNAME",

    [switch]$SetEnvVars
)

$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    throw "Run this script from an elevated (Administrator) PowerShell prompt - registering a scheduled task and setting machine-level environment variables both require it."
}

if ($SetEnvVars) {
    $email = Read-Host "ProjectDox service account email"
    $securePwd = Read-Host "ProjectDox service account password" -AsSecureString
    $plainPwd = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePwd))
    [Environment]::SetEnvironmentVariable("PROJECTDOX_ADMIN_EMAIL", $email, "Machine")
    [Environment]::SetEnvironmentVariable("PROJECTDOX_ADMIN_PASSWORD", $plainPwd, "Machine")
    Write-Host "PROJECTDOX_ADMIN_EMAIL / PROJECTDOX_ADMIN_PASSWORD set as machine-level environment variables."
    Write-Host "NOTE: this stores the password in the Windows registry (HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment), readable by local Administrators on this machine - normal for a service-account credential, but worth knowing."
}

$scriptPath = Join-Path $PSScriptRoot "Get-WorkloadSnapshot.ps1"
if (-not (Test-Path $scriptPath)) { throw "Get-WorkloadSnapshot.ps1 not found next to this script." }

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`"" `
    -WorkingDirectory $PSScriptRoot

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration ([TimeSpan]::MaxValue)

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Hours 1)

Write-Host "Registering task '$TaskName' to run every $IntervalMinutes minute(s) as $RunAsUser ..."
Write-Host "You'll be prompted for $RunAsUser's WINDOWS logon password (not the ProjectDox one)."

$cred = Get-Credential -UserName $RunAsUser -Message "Windows account the scheduled task will run as"

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Highest -Force | Out-Null

Write-Host "`nTask registered. Verify with:"
Write-Host "  Get-ScheduledTask -TaskName `"$TaskName`" | Get-ScheduledTaskInfo"
Write-Host "`nRun it once now to confirm it works unattended:"
Write-Host "  Start-ScheduledTask -TaskName `"$TaskName`""
Write-Host "then check workload-snapshot.json's GeneratedAt timestamp updates and no Get-Credential prompt was needed."
