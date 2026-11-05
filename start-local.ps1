$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (!$node) {
    $node = 'C:\Users\peopl\AppData\Local\strawberry\sandbox\.sandbox-bin\win32-x64\node-dist\node.exe'
}
if (!(Test-Path $node)) { throw 'Node.js was not found. Install Node.js or run from a terminal with Node on PATH.' }
$python = Join-Path $root 'backend\.venv\Scripts\python.exe'
if (!(Test-Path $python)) { throw 'The backend virtual environment is missing.' }
function Start-Server($port, $directory, $command) {
    $listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($listening) { Write-Host "Port $port is already running; leaving it unchanged."; return }
    $script = "Set-Location '$directory'; $command"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    Start-Process powershell.exe -ArgumentList '-NoProfile', '-NoExit', '-EncodedCommand', $encoded | Out-Null
}
Start-Server 8765 $root "& '$python' -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8765"
Start-Server 5174 "$root\frontend" "& '$node' node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5174 --strictPort"
Write-Host 'Keep both server windows open. Open http://127.0.0.1:5174 after Vite reports ready.'
