# 安装/更新本机 PC 管家（不需要管理员权限）
$ErrorActionPreference = "Stop"
$repo = "C:\Users\anzu\Documents\xin\onebot-framework"
$node = "C:\Program Files\nodejs\node.exe"
$agent = Join-Path $repo "tools\pc-agent\pc-agent.js"
$startup = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup\pc-agent.vbs"

if (-not (Test-Path $node)) { throw "找不到 $node" }
if (-not (Test-Path $agent)) { throw "找不到 $agent" }

$vbs = @"
Set sh = CreateObject("WScript.Shell")
Do
  sh.Run """$node"" ""$agent""", 0, True
  WScript.Sleep 5000
Loop
"@
Set-Content -Path $startup -Value $vbs -Encoding ASCII

# 立刻启动（如果还没在跑）
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*pc-agent.js*" }
if (-not $running) { Start-Process -FilePath $node -ArgumentList $agent -WindowStyle Hidden }
Write-Output "PC 管家已安装，登录自启：$startup"
