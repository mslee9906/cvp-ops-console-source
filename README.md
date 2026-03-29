# CVP Ops Console

Read-only prototype console for CVP-managed devices.

This app is designed for simple operational lookup:

- Check whether an IP, VLAN, BGP AS, or VRF is already visible in the current CVP snapshot
- Browse CVP-registered devices and open the latest saved running config
- Support operator judgment before allocating values to a new device or service

It is not positioned as an incident detector or change automation tool.

## Current Scope

- Backend: FastAPI + SQLite snapshot store
- Frontend: React + Vite operational console UI
- Source modes:
  - `demo`: loads local sample snapshot data
  - `cvp`: collects from the local `cloudvision-python-trunk` library and CVP credentials

## Project Layout

```text
cvp-ops-console/
  backend/
    app/
    config/
    data/
  frontend/
```

## What The Prototype Shows

- IP lookup
  - exact match: already in use
  - subnet overlap: review required
  - loopback or management exact match: strictly blocked
- BGP AS lookup
  - shows which device and VRF already use the ASN
- VLAN lookup
  - checks ID, name, and the combination of both
- VRF lookup
  - shows devices where the VRF exists
- Device explorer
  - lists indexed devices
  - opens the latest config backup stored on disk

## Local Run

### Frontend

```powershell
cd "C:\Users\mslee\Desktop\Project\CVP Project\cvp-ops-console\frontend"
npm install
npm run dev
```

### Backend

The backend uses a local `uv` binary and a local virtual environment so it does not depend on system Python.

```powershell
cd "C:\Users\mslee\Desktop\Project\CVP Project\cvp-ops-console"
.\.tools\uv\uv.exe venv backend\.venv --python 3.12
.\.tools\uv\uv.exe pip install --python backend\.venv -r backend\requirements.txt
.\.tools\uv\uv.exe pip install --python backend\.venv -e ..\cloudvision-python-trunk

cd backend
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Convenience scripts:

```powershell
cd "C:\Users\mslee\Desktop\Project\CVP Project\cvp-ops-console\backend"
.\run-demo.ps1
.\run-live.ps1 -CvpHost 192.0.2.10 -Username cvpadmin -Password 'example'
```

Frontend dev server:

- [http://127.0.0.1:5173](http://127.0.0.1:5173)

Backend API:

- [http://127.0.0.1:8000/health](http://127.0.0.1:8000/health)
- [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)

## Portable Deployment

If the target PC must not install anything, build a portable package on the development PC first.

```powershell
cd "C:\Users\mslee\Desktop\Project\CVP Project\cvp-ops-console"
.\scripts\build-portable.ps1
```

This creates:

- `dist-portable\cvp-ops-console-portable`

The portable package contains:

- a bundled Python runtime
- backend dependencies already installed
- the built frontend static files
- the local `cloudvision-python-trunk` library
- simple launchers: `run-live.bat` and `run-demo.bat`

Target PC workflow:

1. Copy the generated `cvp-ops-console-portable` folder
2. Edit `config\live.env`
3. Double-click `run-live.bat`
4. Open [http://127.0.0.1:8000](http://127.0.0.1:8000)

No `npm`, `venv`, or system Python installation is required on the target PC.

## Environment

Copy `backend/.env.example` into your preferred environment loader or set variables manually.

Important variables:

- `OPS_CONSOLE_USE_MOCK=true`
- `CVP_HOST=...`
- `CVP_PORT=443`
- `CVP_TOKEN=...`
- `CVP_USERNAME=...`
- `CVP_PASSWORD=...`
- `CVP_DEVICE_IDS=deviceId1,deviceId2`
- `OPS_CONSOLE_CORS=http://localhost:5173,http://127.0.0.1:5173`

If `OPS_CONSOLE_USE_MOCK=false` and valid CVP credentials are set, the backend will try to collect from CVP.

Authentication can be done in either of these ways:

- service/session token with `CVP_TOKEN`
- username/password with `CVP_USERNAME` and `CVP_PASSWORD`

For on-prem systems with self-signed TLS, the backend will try to fetch the server certificate automatically when no CA file is provided.

## Current Telemetry Assumptions

- BGP:
  - `/Devices/<device_id>/versioned-data/routing/bgp/config/vrf/<vrf>`
- VRF:
  - `/Smash/vrf/vrfIdMapStatus/vrfIdToName`
- Config:
  - `/Config/running/lines/`
- VLAN:
  - `/Sysdb/bridging/config/vlanConfig/*`
  - `/Sysdb/interface/config/eth/vlan/intfConfig/*`
- IP:
  - parsed from saved running config in v1

## Notes

- Config files are stored on disk under `backend/data/configs/`
- SQLite data is stored under `backend/data/db/`
- If a refresh fails, the previous snapshot is preserved and only the latest job status changes to `failed`
