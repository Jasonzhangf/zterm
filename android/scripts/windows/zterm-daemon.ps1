param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

$ErrorActionPreference = "Stop"

function Resolve-PackageRoot {
  if ($env:ZTERM_PACKAGE_ROOT) {
    if (-not (Test-Path -LiteralPath $env:ZTERM_PACKAGE_ROOT)) {
      throw "missing daemon package root: $env:ZTERM_PACKAGE_ROOT"
    }
    return (Resolve-Path -LiteralPath $env:ZTERM_PACKAGE_ROOT).Path
  }
  return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
}

$PackageRoot = Resolve-PackageRoot
$NativeDir = Join-Path $PackageRoot "runtime"
$DagpipeNative = Join-Path $NativeDir "dagpipe.node"
if (-not (Test-Path -LiteralPath $DagpipeNative)) {
  throw "missing daemon DAGPIPE native: $DagpipeNative"
}
$env:ZTERM_DAGPIPE_NATIVE = $DagpipeNative
$env:PATH = "$NativeDir;$env:PATH"
$RuntimeEntry = Join-Path $NativeDir "server.cjs"
$TerminalConfigCommand = Join-Path $PackageRoot "support\terminal-config-command.cjs"
$NodeExe = if ($env:ZTERM_NODE_EXE) { $env:ZTERM_NODE_EXE } else { "node.exe" }
$HomeDir = [Environment]::GetFolderPath("UserProfile")
$ZtermHome = Join-Path $HomeDir ".zterm"
$RunDir = Join-Path $ZtermHome "run"
$LogDir = Join-Path $ZtermHome "logs"
$PidFile = Join-Path $RunDir "zterm-daemon.pid"
$TaskName = "ZTermDaemon"
$FirewallRuleName = "ZTerm Daemon 3333"

function Assert-TerminalConfigCommand {
  if (-not (Test-Path -LiteralPath $TerminalConfigCommand)) {
    throw "missing shared terminal config command: $TerminalConfigCommand"
  }
}

function ConvertFrom-ShellSingleQuotedValue([string]$Value) {
  if ($Value.Length -lt 2 -or $Value[0] -ne "'" -or $Value[$Value.Length - 1] -ne "'") {
    throw "invalid terminal config shell value: $Value"
  }
  return $Value.Substring(1, $Value.Length - 2).Replace("'\''", "'")
}

function Invoke-TerminalConfigCommand([string[]]$CommandArgs) {
  Assert-TerminalConfigCommand
  $output = @(& $NodeExe $TerminalConfigCommand @CommandArgs)
  if ($LASTEXITCODE -ne 0) {
    throw "terminal-config-command failed with exit code $LASTEXITCODE"
  }
  return $output
}

function Read-DaemonConfig {
  $values = @{}
  foreach ($line in (Invoke-TerminalConfigCommand @("daemon-config", "--shell"))) {
    if ($line -match '^(HOST|PORT|SESSION_NAME|AUTH_SOURCE|CONFIG_FOUND|CONFIG_DISPLAY_PATH)=(.*)$') {
      $values[$Matches[1]] = ConvertFrom-ShellSingleQuotedValue $Matches[2]
    }
  }
  foreach ($name in @("HOST", "PORT", "SESSION_NAME", "AUTH_SOURCE", "CONFIG_FOUND", "CONFIG_DISPLAY_PATH")) {
    if (-not $values.ContainsKey($name)) {
      throw "terminal config projection omitted $name"
    }
  }
  [pscustomobject]@{
    Host = [string]$values["HOST"]
    Port = [int]$values["PORT"]
    AuthSource = [string]$values["AUTH_SOURCE"]
    ConfigPath = [string]$values["CONFIG_DISPLAY_PATH"]
    ConfigFound = $values["CONFIG_FOUND"] -eq "1"
  }
}

function Test-PortListening([int]$Port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $task = $client.ConnectAsync("127.0.0.1", $Port)
    if (-not $task.Wait(250)) { return $false }
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Wait-PortListening([int]$Port) {
  for ($i = 0; $i -lt 40; $i++) {
    if (Test-PortListening $Port) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Wait-PortClosed([int]$Port) {
  for ($i = 0; $i -lt 40; $i++) {
    if (-not (Test-PortListening $Port)) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Read-DaemonPid {
  if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
  $value = (Get-Content -LiteralPath $PidFile -Raw).Trim()
  if (-not $value) { return $null }
  return [int]$value
}

function Test-PidRunning([int]$ProcessId) {
  try {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    return $null -ne $process
  } catch {
    return $false
  }
}

function Ensure-Dirs {
  New-Item -ItemType Directory -Force -Path $ZtermHome, $RunDir, $LogDir | Out-Null
}

function Ensure-WindowsBackendEnv {
  if (-not $env:ZTERM_TERMINAL_BACKEND) {
    $env:ZTERM_TERMINAL_BACKEND = "wezterm"
  }
  if ($env:ZTERM_WEZTERM_EXE -and (Test-Path -LiteralPath $env:ZTERM_WEZTERM_EXE)) {
    return
  }
  $pathCandidate = Get-Command "wezterm.exe" -ErrorAction SilentlyContinue
  if ($pathCandidate -and $pathCandidate.Source) {
    $env:ZTERM_WEZTERM_EXE = $pathCandidate.Source
    return
  }
  $portableRoots = @(
    "D:\zterm-tools\wezterm\portable",
    (Join-Path $HomeDir "zterm-tools\wezterm\portable")
  )
  foreach ($root in $portableRoots) {
    if (-not (Test-Path -LiteralPath $root)) {
      continue
    }
    $candidate = Get-ChildItem -LiteralPath $root -Filter "wezterm.exe" -Recurse -ErrorAction SilentlyContinue |
      Sort-Object FullName |
      Select-Object -First 1
    if ($candidate -and (Test-Path -LiteralPath $candidate.FullName)) {
      $env:ZTERM_WEZTERM_EXE = $candidate.FullName
      return
    }
  }
}

function Invoke-ConfigureRelay([string[]]$CommandArgs) {
  $relayUrl = ""
  $username = ""
  $password = ""
  $hostId = ""
  $deviceId = ""
  $deviceName = ""
  $passwordStdin = $false
  $restartAfterConfig = $false
  for ($i = 0; $i -lt $CommandArgs.Count; $i++) {
    switch ($CommandArgs[$i]) {
      "--relay-url" { $i++; $relayUrl = $CommandArgs[$i]; continue }
      "--username" { $i++; $username = $CommandArgs[$i]; continue }
      "--password" { throw "relay passwords are accepted only with --password-stdin" }
      "--password-env" { throw "relay passwords are accepted only with --password-stdin" }
      "--password-stdin" { $password = [Console]::In.ReadLine(); $passwordStdin = $true; continue }
      "--host-id" { $i++; $hostId = $CommandArgs[$i]; continue }
      "--device-id" { $i++; $deviceId = $CommandArgs[$i]; continue }
      "--device-name" { $i++; $deviceName = $CommandArgs[$i]; continue }
      "--restart-service" { $restartAfterConfig = $true; continue }
      "--no-restart" { $restartAfterConfig = $false; continue }
      default { throw "unknown configure-relay option: $($CommandArgs[$i])" }
    }
  }
  if (-not $relayUrl -or -not $username -or -not $password -or -not $hostId -or -not $passwordStdin) {
    throw "configure-relay requires --relay-url, --username, --password-stdin, and --host-id"
  }
  Assert-TerminalConfigCommand
  $commandArgs = @(
    $TerminalConfigCommand,
    "configure-relay",
    "--relay-url", $relayUrl,
    "--username", $username,
    "--host-id", $hostId,
    "--password-stdin"
  )
  if ($deviceId) { $commandArgs += @("--device-id", $deviceId) }
  if ($deviceName) { $commandArgs += @("--device-name", $deviceName) }
  $password | & $NodeExe @commandArgs
  if ($LASTEXITCODE -ne 0) {
    throw "terminal-config-command failed with exit code $LASTEXITCODE"
  }
  if ($restartAfterConfig) { Invoke-Restart }
}

function Invoke-Config {
  Invoke-TerminalConfigCommand @("daemon-config") | Write-Output
}

function Invoke-Run {
  if (-not (Test-Path -LiteralPath $RuntimeEntry)) {
    throw "missing daemon runtime: $RuntimeEntry"
  }
  Ensure-Dirs
  Ensure-WindowsBackendEnv
  Set-Location $HomeDir
  & $NodeExe $RuntimeEntry
}

function Invoke-StartDirect {
  $config = Read-DaemonConfig
  Ensure-Dirs
  $existingPid = Read-DaemonPid
  if ($existingPid -and (Test-PidRunning $existingPid) -and (Test-PortListening $config.Port)) {
    Write-Output "zterm daemon already running: pid=$existingPid host=$($config.Host) port=$($config.Port) auth=$($config.AuthSource)"
    return
  }
  if ($existingPid -and -not (Test-PidRunning $existingPid)) {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  }
  if (Test-PortListening $config.Port) {
    throw "zterm daemon listener already exists on port $($config.Port), but managed pid truth is missing"
  }
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $stdoutLog = Join-Path $LogDir "daemon-$($config.Port)-$timestamp.out.log"
  $stderrLog = Join-Path $LogDir "daemon-$($config.Port)-$timestamp.err.log"
  Ensure-WindowsBackendEnv
  $process = Start-Process -FilePath $NodeExe -ArgumentList @($RuntimeEntry) -WorkingDirectory $HomeDir -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
  Set-Content -LiteralPath $PidFile -Value ([string]$process.Id)
  if (-not (Wait-PortListening $config.Port)) {
    if (Test-PidRunning $process.Id) {
      Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    throw "zterm daemon failed to become ready on port $($config.Port); stdout=$stdoutLog stderr=$stderrLog"
  }
  Write-Output "zterm daemon started"
  Write-Output "pid=$($process.Id)"
  Write-Output "host=$($config.Host)"
  Write-Output "port=$($config.Port)"
  Write-Output "auth=$($config.AuthSource)"
  Write-Output "config=$($config.ConfigPath)"
  Write-Output "pidFile=$PidFile"
  Write-Output "stdout=$stdoutLog"
  Write-Output "stderr=$stderrLog"
}

function Invoke-StopDirect {
  $config = Read-DaemonConfig
  $daemonPid = Read-DaemonPid
  if (-not $daemonPid) {
    if (Test-PortListening $config.Port) {
      throw "zterm daemon listener is up on port $($config.Port), but managed pid truth is missing"
    }
    Write-Output "zterm daemon not running ($($config.Port))"
    return
  }
  if (-not (Test-PidRunning $daemonPid)) {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    if (Test-PortListening $config.Port) {
      throw "zterm daemon listener is up on port $($config.Port), but pid $daemonPid is stale"
    }
    Write-Output "zterm daemon not running ($($config.Port))"
    return
  }
  Stop-Process -Id $daemonPid -ErrorAction Stop
  if (-not (Wait-PortClosed $config.Port)) {
    throw "zterm daemon did not stop listening on port $($config.Port) after pid $daemonPid was terminated"
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  Write-Output "zterm daemon stopped: pid=$daemonPid"
}

function Test-TaskInstalled {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  return $null -ne $task
}

function Ensure-FirewallRule {
  $config = Read-DaemonConfig
  $current = Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue
  if ($current) {
    return
  }
  New-NetFirewallRule -DisplayName $FirewallRuleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $config.Port -Profile Any | Out-Null
}

function Invoke-InstallService {
  Ensure-Dirs
  Ensure-FirewallRule
  if (Test-TaskInstalled) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  $taskUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" run"
  $triggers = @(
    (New-ScheduledTaskTrigger -AtStartup),
    (New-ScheduledTaskTrigger -AtLogOn -User $taskUser)
  )
  $principal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType S4U -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description "ZTerm Windows daemon" | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  $config = Read-DaemonConfig
  if (-not (Wait-PortListening $config.Port)) {
    throw "zterm windows autostart service unhealthy after install: task=$TaskName port=$($config.Port)"
  }
  Write-Output "zterm windows autostart service installed: task=$TaskName port=$($config.Port)"
}

function Invoke-UninstallService {
  if (Test-TaskInstalled) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  Write-Output "zterm windows autostart service uninstalled: task=$TaskName"
}

function Invoke-ServiceStatus {
  $config = Read-DaemonConfig
  if (-not (Test-TaskInstalled)) {
    Write-Output "zterm windows autostart service not installed"
    Write-Output "task=$TaskName"
    exit 1
  }
  $task = Get-ScheduledTask -TaskName $TaskName
  if (Test-PortListening $config.Port) {
    Write-Output "zterm windows autostart service running: task=$TaskName host=$($config.Host) port=$($config.Port) auth=$($config.AuthSource) state=$($task.State)"
    return
  }
  Write-Output "zterm windows autostart service installed but unhealthy: task=$TaskName state=$($task.State) listener=down port=$($config.Port)"
  exit 1
}

function Invoke-Status {
  $config = Read-DaemonConfig
  $daemonPid = Read-DaemonPid
  if ($daemonPid -and (Test-PidRunning $daemonPid) -and (Test-PortListening $config.Port)) {
    Write-Output "zterm daemon running: pid=$daemonPid host=$($config.Host) port=$($config.Port) auth=$($config.AuthSource)"
    return
  }
  if (Test-PortListening $config.Port) {
    Write-Output "zterm daemon listener is up on port $($config.Port), but managed pid truth is missing"
    exit 1
  }
  Write-Output "zterm daemon not running ($($config.Port))"
  Write-Output "config=$($config.ConfigPath) found=$($config.ConfigFound) auth=$($config.AuthSource)"
  exit 1
}

function Invoke-Start {
  if (Test-TaskInstalled) {
    Start-ScheduledTask -TaskName $TaskName
    $config = Read-DaemonConfig
    if (-not (Wait-PortListening $config.Port)) {
      throw "zterm windows autostart service unhealthy after start: task=$TaskName port=$($config.Port)"
    }
    Invoke-ServiceStatus
    return
  }
  Invoke-StartDirect
}

function Invoke-Stop {
  if (Test-TaskInstalled) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $config = Read-DaemonConfig
    if (-not (Wait-PortClosed $config.Port)) {
      throw "zterm windows autostart service did not stop listening on port $($config.Port)"
    }
    Write-Output "zterm windows autostart service stopped: task=$TaskName"
    return
  }
  Invoke-StopDirect
}

function Invoke-Restart {
  if (Test-TaskInstalled) {
    Invoke-Stop
    Start-ScheduledTask -TaskName $TaskName
    $config = Read-DaemonConfig
    if (-not (Wait-PortListening $config.Port)) {
      throw "zterm windows autostart service unhealthy after restart: task=$TaskName port=$($config.Port)"
    }
    Invoke-ServiceStatus
    return
  }
  Invoke-StopDirect
  Invoke-StartDirect
}

function Show-Usage {
  @"
Usage:
  zterm-daemon run
  zterm-daemon start
  zterm-daemon status
  zterm-daemon config
  zterm-daemon stop
  zterm-daemon restart
  zterm-daemon configure-relay --relay-url URL --username USER --password-stdin --host-id HOST_ID [--device-name NAME] [--restart-service]
  zterm-daemon install-service
  zterm-daemon uninstall-service
  zterm-daemon service-status
"@
}

$command = if ($Args.Count -gt 0) { $Args[0] } else { "help" }
$rest = if ($Args.Count -gt 1) { $Args[1..($Args.Count - 1)] } else { @() }

switch ($command) {
  "run" { Invoke-Run }
  "start" { Invoke-Start }
  "status" { Invoke-Status }
  "config" { Invoke-Config }
  "stop" { Invoke-Stop }
  "restart" { Invoke-Restart }
  "configure-relay" { Invoke-ConfigureRelay $rest }
  "install-service" { Invoke-InstallService }
  "uninstall-service" { Invoke-UninstallService }
  "service-status" { Invoke-ServiceStatus }
  "help" { Show-Usage }
  "-h" { Show-Usage }
  "--help" { Show-Usage }
  default {
    Write-Error "unknown command: $command"
    Show-Usage
    exit 1
  }
}
