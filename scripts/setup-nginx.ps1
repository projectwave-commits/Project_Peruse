#Requires -RunAsAdministrator
# Adds the app's route to an existing nginx. The site already there is down for a few seconds
# if nginx runs as a Windows service, because a service can only be updated by restarting it.
# Backs up nginx.conf first, and restores it if nginx rejects the result. Safe to run again.

param([string]$NginxDir = 'C:\tools\nginx-1.31.3')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$conf = Join-Path $NginxDir 'conf\nginx.conf'
$route = Join-Path $NginxDir 'conf\nginx-prefect.conf'
$exe = Join-Path $NginxDir 'nginx.exe'
$backup = "$conf.before-prefects-$(Get-Date -Format yyyyMMdd-HHmmss)"

function Test-Nginx {
    # nginx writes its normal result to stderr, which cmd passes on as plain text.
    Write-Host (cmd /c "`"$exe`" -p `"$NginxDir`" -t 2>&1" | Out-String)
    return ($LASTEXITCODE -eq 0)
}

if (-not (Test-Nginx)) { throw 'nginx.conf already has errors, so nothing was changed.' }

$hadRoute = Test-Path $route
$oldRoute = if ($hadRoute) { Get-Content $route -Raw } else { $null }
Copy-Item $conf $backup
Copy-Item (Join-Path $PSScriptRoot 'nginx-prefect.conf') $route -Force

$text = Get-Content $conf -Raw
if ($text -notmatch 'include\s+nginx-prefect\.conf') {
    $pattern = [regex]'(?m)^(\s*)location\s+/\s*\{'
    if (-not $pattern.IsMatch($text)) { throw "Could not find 'location / {' in nginx.conf, so nothing was changed." }
    $text = $pattern.Replace($text, { param($m) "$($m.Groups[1].Value)include nginx-prefect.conf;`r`n`r`n$($m.Value)" }, 1)
    [IO.File]::WriteAllText($conf, $text, (New-Object Text.UTF8Encoding($false)))
}

if (-not (Test-Nginx)) {
    Copy-Item $backup $conf -Force
    if ($hadRoute) { [IO.File]::WriteAllText($route, $oldRoute) } else { Remove-Item $route }
    throw 'nginx rejected the change, so the old config was put back. Nothing was reloaded.'
}

# A reload only reaches one nginx, and a service's nginx may refuse it, so services are restarted.
$services = @(Get-CimInstance Win32_Service | Where-Object { $_.Name -match 'nginx' -and $_.State -eq 'Running' })
if ($services.Count) {
    foreach ($service in $services) {
        Restart-Service -Name $service.Name
        Write-Host "Restarted the $($service.Name) service."
    }
} else {
    cmd /c "`"$exe`" -p `"$NginxDir`" -s reload 2>&1"
    if ($LASTEXITCODE -ne 0) { throw "nginx did not reload. The previous config is saved at $backup." }
}
Write-Host "Route added. Previous config: $backup"

try {
    $status = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 'http://127.0.0.1:3080/').StatusCode
    Write-Host "The app is answering on port 3080 (HTTP $status)."
} catch {
    Write-Warning 'The app is not answering on port 3080. Run scripts\install-windows.ps1 and check the Prefects App scheduled task.'
}
Write-Host 'Now check from a phone: http://10.2.0.190/demerits/ should open the app.'
Write-Host 'Also check the Meraki ngrok address with /demerits/ on the end: it should say 403 Forbidden.'
