#Requires -RunAsAdministrator
# Starts the Prefects app whenever the server boots, restarts it if it stops,
# and opens its port to the school network only. Safe to run again.

param([int]$Port = 3080)

$ErrorActionPreference = 'Stop'
$taskName = 'Prefects App'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe).Source

$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
    $line = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
    if ($line) { $Port = [int]$line.Matches[0].Groups[1].Value }
    $behindProxy = [bool](Select-String -Path $envFile -Pattern '^\s*HOST\s*=\s*127\.0\.0\.1\s*$')
}

$action = New-ScheduledTaskAction -Execute $node -WorkingDirectory $root `
    -Argument '--disable-warning=ExperimentalWarning --env-file-if-exists=.env server/index.js'
$trigger = New-ScheduledTaskTrigger -AtStartup
# Not SYSTEM: this may share a server with more important roles.
$account = 'NT AUTHORITY\NETWORK SERVICE'
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType ServiceAccount -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1)

# Student records: only this account and administrators can read them.
$data = Join-Path $root 'data'
New-Item -ItemType Directory -Force $data | Out-Null
icacls $data /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-20:(OI)(CI)M' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not set permissions on the data folder.' }

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

# LocalSubnet only: the app is not reachable from outside the school network through this rule.
$rule = 'Prefects App'
Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
# Behind nginx, phones never reach this port directly.
if (-not $behindProxy) {
    New-NetFirewallRule -DisplayName $rule -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet | Out-Null
}

Start-ScheduledTask -TaskName $taskName
Write-Host "Installed. The app is starting on port $Port and will start with Windows."
if (-not $behindProxy) {
    Write-Host 'If phones are on a different subnet from the server, widen -RemoteAddress on the firewall rule.'
}
