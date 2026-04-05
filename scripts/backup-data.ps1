param()

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$consoleDir = Split-Path -Parent $scriptDir
$backendDir = Join-Path $consoleDir "backend"
$pythonExe = Join-Path $backendDir ".venv\\Scripts\\python.exe"

if (-not (Test-Path $pythonExe)) {
    throw "Python executable not found: $pythonExe"
}

$env:OPS_CONSOLE_BACKEND_DIR = $backendDir

@'
import sys
import os
from pathlib import Path
backend_dir = Path(os.environ["OPS_CONSOLE_BACKEND_DIR"])
sys.path.insert(0, str(backend_dir))
from app.core.settings import get_settings
from app.services.backup_service import BackupService

settings = get_settings()
service = BackupService(
    console_dir=settings.console_dir,
    backend_dir=settings.backend_dir,
    primary_db_path=settings.db_path,
    history_db_path=settings.db_path.with_name("ops_console_history.db"),
    config_snapshot_dir=settings.config_dir,
)
result = service.create_backup()
print(result["path"])
'@ | & $pythonExe -
