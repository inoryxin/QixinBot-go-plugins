# 安装/更新本机 PC 管家（Go 单文件，不需要管理员）
$ErrorActionPreference = "Stop"
$dir = "C:\Users\anzu\Documents\xin\onebot-framework\tools\pc-agent"
$exe = Join-Path $dir "pc-agent.exe"
if (-not (Test-Path $exe)) {
  Push-Location "C:\Users\anzu\Documents\xin\onebot-framework"
  try { go build -ldflags="-H=windowsgui" -o $exe ".\tools\pc-agent" } finally { Pop-Location }
}
$startup = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
$cmd = Join-Path $startup "pc-agent.cmd"
@"
@echo off
start "" /min "$exe" -port 3097 -token pc-7f3a91c2
"@ | Set-Content -Path $cmd -Encoding ASCII
if (-not (Get-Process pc-agent -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath $exe -ArgumentList '-port','3097','-token','pc-7f3a91c2' -WindowStyle Hidden
}
Write-Output "PC 管家已安装：$exe"
