param(
    [string]$OutputDir = "",
    [string]$PythonHome = "",
    [switch]$SkipFrontendBuild
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$consoleDir = Split-Path -Parent $scriptDir
$backendDir = Join-Path $consoleDir "backend"
$frontendDir = Join-Path $consoleDir "frontend"
$cloudvisionDir = Join-Path (Split-Path -Parent $consoleDir) "cloudvision-python-trunk"
$portableReadmeText = Join-Path $consoleDir "docs\\README-portable.txt"
$portableReadmeMarkdown = Join-Path $consoleDir "docs\\README-portable.md"
$uvExe = Join-Path $consoleDir ".tools\\uv\\uv.exe"
$venvPython = Join-Path $backendDir ".venv\\Scripts\\python.exe"

if (-not $OutputDir) {
    $OutputDir = Join-Path $consoleDir "dist-portable\\cvp-ops-console-portable"
}

$outputRoot = [System.IO.Path]::GetFullPath($OutputDir)
$pythonOutput = Join-Path $outputRoot "python"
$backendOutput = Join-Path $outputRoot "backend"
$frontendOutput = Join-Path $outputRoot "frontend"
$frontendDistOutput = Join-Path $frontendOutput "dist"
$configOutput = Join-Path $outputRoot "config"
$sitePackages = Join-Path $pythonOutput "Lib\\site-packages"

if (-not (Test-Path $uvExe)) {
    throw "uv executable not found: $uvExe"
}

if (-not (Test-Path $venvPython)) {
    throw "Backend virtual environment Python not found: $venvPython"
}

if (-not (Test-Path $cloudvisionDir)) {
    throw "cloudvision-python-trunk not found: $cloudvisionDir"
}

if (-not $PythonHome) {
    $PythonHome = (& $venvPython -c "import sys; print(sys.base_prefix)").Trim()
}

if (-not (Test-Path $PythonHome)) {
    throw "Python runtime directory not found: $PythonHome"
}

if (-not $SkipFrontendBuild) {
    Push-Location $frontendDir
    try {
        npm run build
    }
    finally {
        Pop-Location
    }
}

$frontendDist = Join-Path $frontendDir "dist"
if (-not (Test-Path $frontendDist)) {
    throw "Frontend build output not found: $frontendDist"
}

if (Test-Path $outputRoot) {
    Remove-Item -LiteralPath $outputRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $outputRoot | Out-Null
New-Item -ItemType Directory -Path $pythonOutput -Force | Out-Null
New-Item -ItemType Directory -Path $backendOutput -Force | Out-Null
New-Item -ItemType Directory -Path $frontendDistOutput -Force | Out-Null
New-Item -ItemType Directory -Path $configOutput -Force | Out-Null

Write-Host "Copying portable Python runtime..."
Copy-Item -Path (Join-Path $PythonHome "*") -Destination $pythonOutput -Recurse -Force

Write-Host "Installing backend dependencies into portable runtime..."
New-Item -ItemType Directory -Path $sitePackages -Force | Out-Null
& $uvExe pip install --python (Join-Path $pythonOutput "python.exe") --target $sitePackages -r (Join-Path $backendDir "requirements.txt")

Write-Host "Copying backend application..."
Copy-Item -Path (Join-Path $backendDir "app") -Destination $backendOutput -Recurse -Force
Copy-Item -Path (Join-Path $backendDir "config") -Destination $backendOutput -Recurse -Force
New-Item -ItemType Directory -Path (Join-Path $backendOutput "data\\db") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $backendOutput "data\\configs") -Force | Out-Null
Copy-Item -Path (Join-Path $backendDir "data\\sample_snapshot.json") -Destination (Join-Path $backendOutput "data\\sample_snapshot.json") -Force

Write-Host "Copying built frontend..."
Copy-Item -Path (Join-Path $frontendDist "*") -Destination $frontendDistOutput -Recurse -Force

Write-Host "Copying CloudVision library..."
Copy-Item -Path $cloudvisionDir -Destination (Join-Path $outputRoot "cloudvision-python-trunk") -Recurse -Force

$liveEnv = @"
CVP_HOST=192.168.237.78
CVP_PORT=443
CVP_USERNAME=cvpadmin
CVP_PASSWORD=change-me
CVP_INSECURE_TLS=false
CVP_DEVICE_IDS=
OPS_CONSOLE_BIND_HOST=0.0.0.0
OPS_CONSOLE_BIND_PORT=8000
"@

$runLiveBat = @"
@echo off
setlocal EnableExtensions
set "ROOT=%~dp0"
set "ENV_FILE=%ROOT%config\live.env"

if not exist "%ENV_FILE%" (
  echo Missing config\live.env
  exit /b 1
)

for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
  if not "%%A"=="" (
    if /I not "%%A:~0,1%"=="#" (
      set "%%A=%%B"
    )
  )
)

set "OPS_CONSOLE_USE_MOCK=false"
set "OPS_CONSOLE_CVP_LIBRARY_ROOT=%ROOT%cloudvision-python-trunk"
set "PYTHONUTF8=1"

if not defined OPS_CONSOLE_BIND_HOST set "OPS_CONSOLE_BIND_HOST=0.0.0.0"
if not defined OPS_CONSOLE_BIND_PORT set "OPS_CONSOLE_BIND_PORT=8000"

pushd "%ROOT%"
"%ROOT%python\python.exe" -m uvicorn app.main:app --app-dir "%ROOT%backend" --host %OPS_CONSOLE_BIND_HOST% --port %OPS_CONSOLE_BIND_PORT%
popd

endlocal
"@

$runDemoBat = @"
@echo off
setlocal EnableExtensions
set "ROOT=%~dp0"
set "OPS_CONSOLE_USE_MOCK=true"
set "OPS_CONSOLE_CVP_LIBRARY_ROOT=%ROOT%cloudvision-python-trunk"
set "PYTHONUTF8=1"

if not defined OPS_CONSOLE_BIND_HOST set "OPS_CONSOLE_BIND_HOST=127.0.0.1"
if not defined OPS_CONSOLE_BIND_PORT set "OPS_CONSOLE_BIND_PORT=8000"

pushd "%ROOT%"
"%ROOT%python\python.exe" -m uvicorn app.main:app --app-dir "%ROOT%backend" --host %OPS_CONSOLE_BIND_HOST% --port %OPS_CONSOLE_BIND_PORT%
popd

endlocal
"@

Set-Content -Path (Join-Path $configOutput "live.env") -Value $liveEnv -Encoding ASCII
Set-Content -Path (Join-Path $outputRoot "run-live.bat") -Value $runLiveBat -Encoding ASCII
Set-Content -Path (Join-Path $outputRoot "run-demo.bat") -Value $runDemoBat -Encoding ASCII

if (Test-Path $portableReadmeText) {
    Copy-Item -Path $portableReadmeText -Destination (Join-Path $outputRoot "README.txt") -Force
}

if (Test-Path $portableReadmeMarkdown) {
    Copy-Item -Path $portableReadmeMarkdown -Destination (Join-Path $outputRoot "README.md") -Force
}

Write-Host ""
Write-Host "Portable package created:"
Write-Host $outputRoot
