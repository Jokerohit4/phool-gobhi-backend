$ErrorActionPreference = 'Stop'
$taskName = 'PhoolGobhi Production Health Warmup'
$installDir = Join-Path $env:LOCALAPPDATA 'PhoolGobhi\HealthWarmup'
$scriptPath = Join-Path $installDir 'local_health_warmup.py'
$pythonPath = (Get-Command python.exe).Source
$pythonWindowlessPath = Join-Path (Split-Path $pythonPath) 'pythonw.exe'
$gcloudPath = (Get-Command gcloud.cmd).Source
$account = 'officialrohitashwa@gmail.com'
if (-not (Test-Path -LiteralPath $pythonWindowlessPath)) { throw 'pythonw.exe is required for a hidden task.' }

$servicesJson = & $gcloudPath run services list --project=phool-gobhi --format=json
if ($LASTEXITCODE -ne 0) { throw 'Cannot list Cloud Run services.' }
$services = ($servicesJson -join "`n") | ConvertFrom-Json
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\services.json') -Raw | ConvertFrom-Json
$targets = [ordered]@{}
foreach ($entry in $manifest.services.PSObject.Properties) {
    if ($entry.Name -eq 'gateway') { continue } # Existing cloud uptime checks.
    $baseName = $entry.Value.cloudRunServiceBaseName
    if (-not $baseName) { $baseName = $entry.Name }
    $serviceName = "$baseName-prod"
    $service = @($services | Where-Object { $_.metadata.name -eq $serviceName })
    if ($service.Count -ne 1 -or -not $service[0].status.url) { throw "Cannot resolve $serviceName" }
    $targets[$serviceName] = "$($service[0].status.url)/health"
}
if ($targets.Count -ne 7) { throw 'Expected seven production backends.' }

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and @($existing.Actions | Where-Object { $_.Arguments -eq "`"$scriptPath`"" }).Count -ne 1) {
    throw 'Existing task has an unexpected action; refusing to overwrite.'
}
New-Item -ItemType Directory -Path $installDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'local_health_warmup.py') -Destination $scriptPath -Force
@{ account = $account; gcloud = $gcloudPath; targets = $targets } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $installDir 'health-warmup.json') -Encoding UTF8

# Prove authentication and all health endpoints before installing the task.
& $pythonPath $scriptPath
if ($LASTEXITCODE -ne 0) { throw "Health verification failed. See $installDir\health-warmup.log" }

$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $pythonWindowlessPath -Argument "`"$scriptPath`"" -WorkingDirectory $installDir
$periodic = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($periodic, $logon) -Principal $principal -Settings $settings -Description 'Authenticated GET /health for seven production backends every five minutes. Runs while rohit is signed in and online. Gateway already has uptime checks.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Installed: $taskName"
Write-Output "Logs: $installDir\health-warmup.log"
