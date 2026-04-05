param(
    [Parameter(Mandatory = $true)]
    [string]$BackupName
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$consoleDir = Split-Path -Parent $scriptDir
$backendDir = Join-Path $consoleDir "backend"
$pythonExe = Join-Path $backendDir ".venv\\Scripts\\python.exe"

if (-not (Test-Path $pythonExe)) {
    throw "Python executable not found: $pythonExe"
}

$env:OPS_CONSOLE_BACKEND_DIR = $backendDir
$env:OPS_CONSOLE_BACKUP_NAME = $BackupName

@'
import sys
import os
from pathlib import Path

backend_dir = Path(os.environ["OPS_CONSOLE_BACKEND_DIR"])
backup_name = os.environ["OPS_CONSOLE_BACKUP_NAME"]
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
result = service.restore_backup(backup_name)
print(result["name"])
'@ | & $pythonExe -
