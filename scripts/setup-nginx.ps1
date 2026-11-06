#Requires -RunAsAdministrator
# Adds the route for every app in this repository to the existing nginx: /home/, /demerits/ and /sign_ups/.
# The sites already there are down for a few seconds if nginx runs as a Windows service, because a service
# can only be updated by restarting it. Backs up nginx.conf first, and restores everything if nginx rejects
# the result. Safe to run again.

param([string]$NginxDir = 'C:\tools\nginx-1.31.3')

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$conf = Join-Path $NginxDir 'conf\nginx.conf'
$exe = Join-Path $NginxDir 'nginx.exe'
$backup = "$conf.before-apps-$(Get-Date -Format yyyyMMdd-HHmmss)"
# nginx-prefect.conf keeps its old name, so the include line already on the server stays valid.
$routes = @('nginx-home.conf', 'nginx-prefect.conf', 'nginx-sign-ups.conf')
$utf8 = New-Object Text.UTF8Encoding($false)

function Test-Nginx {
    # nginx writes its normal result to stderr, which cmd passes on as plain text.
    Write-Host (cmd /c "`"$exe`" -p `"$NginxDir`" -t 2>&1" | Out-String)
    return ($LASTEXITCODE -eq 0)
}

if (-not (Test-Nginx)) { throw 'nginx.conf already has errors, so nothing was changed.' }

Copy-Item $conf $backup
$previous = @{}
function Restore-All {
    Copy-Item $backup $conf -Force
    foreach ($name in $routes) {
        $target = Join-Path $NginxDir "conf\$name"
        if ($null -eq $previous[$name]) { Remove-Item $target -ErrorAction SilentlyContinue }
        else { [IO.File]::WriteAllText($target, $previous[$name], $utf8) }
    }
}

foreach ($name in $routes) {
    $target = Join-Path $NginxDir "conf\$name"
    $previous[$name] = if (Test-Path $target) { [IO.File]::ReadAllText($target) } else { $null }
    # The home page is served straight from this folder. nginx wants forward slashes in Windows paths.
    $text = [IO.File]::ReadAllText((Join-Path $PSScriptRoot $name)).Replace('__REPO__', ($repo -replace '\\', '/'))
    [IO.File]::WriteAllText($target, $text, $utf8)
}

$text = Get-Content $conf -Raw
$pattern = [regex]'(?m)^(\s*)location\s+/\s*\{'
foreach ($name in $routes) {
    if ($text -match "include\s+$([regex]::Escape($name))") { continue }
    if (-not $pattern.IsMatch($text)) {
        Restore-All
        throw "Could not find 'location / {' in nginx.conf, so nothing was changed."
    }
    $include = "include $name;"
    $text = $pattern.Replace($text, { param($m) "$($m.Groups[1].Value)$include`r`n`r`n$($m.Value)" }, 1)
}
[IO.File]::WriteAllText($conf, $text, $utf8)

if (-not (Test-Nginx)) {
    Restore-All
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
Write-Host "Routes added. Previous config: $backup"

foreach ($app in @(@{ Port = 3080; Name = 'Demerits'; Task = 'Prefects App' }, @{ Port = 3081; Name = 'Sign-ups'; Task = 'Sports and Clubs App' })) {
    try {
        $status = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "http://127.0.0.1:$($app.Port)/").StatusCode
        Write-Host "$($app.Name) is answering on port $($app.Port) (HTTP $status)."
    } catch {
        Write-Warning "$($app.Name) is not answering on port $($app.Port). Run its scripts\install-windows.ps1 and check the $($app.Task) scheduled task."
    }
}

Write-Host 'Now check from a phone: http://10.2.0.190/home/ should list the apps, and each link should open.'
Write-Host 'Also check the ngrok address with /home/, /demerits/ and /sign_ups/ on the end: each should say 403 Forbidden.'
