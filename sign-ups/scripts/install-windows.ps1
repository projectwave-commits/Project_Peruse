#Requires -RunAsAdministrator
# Starts the app whenever the server boots and restarts it if it stops. Safe to run again.
# It listens on this machine only, so devices reach it through nginx. See ..\scripts\setup-nginx.ps1.

$ErrorActionPreference = 'Stop'
$taskName = 'Sports and Clubs App'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe).Source

$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) {
    Set-Content -Path $envFile -Value @('PORT=3081', 'HOST=127.0.0.1', 'COOKIE_PATH=/sign_ups/')
    Write-Host 'Created .env for running behind nginx at /sign_ups/.'
}

$action = New-ScheduledTaskAction -Execute $node -WorkingDirectory $root `
    -Argument '--disable-warning=ExperimentalWarning --env-file-if-exists=.env server.js'
$trigger = New-ScheduledTaskTrigger -AtStartup
# Not SYSTEM: this shares a server with more important roles.
$account = 'NT AUTHORITY\NETWORK SERVICE'
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType ServiceAccount -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1)

# Student records: only this account and administrators can read them.
$data = Join-Path $root 'data'
New-Item -ItemType Directory -Force $data | Out-Null
icacls $data /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-20:(OI)(CI)M' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not set permissions on the data folder.' }

$lists = Join-Path $root 'class-lists'
if (Test-Path $lists) {
    icacls $lists /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-20:(OI)(CI)RX' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not set permissions on the class-lists folder.' }
} else {
    Write-Warning 'There is no class-lists folder, so the app will start with no students. Upload class lists on Setup.'
}

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $taskName
Write-Host 'Installed. The app is starting and will start with Windows.'
