param(
    [string]$BindHost = '127.0.0.1',
    [int]$BindPort = 8000
)

$env:OPS_CONSOLE_USE_MOCK = 'true'

& .\.venv\Scripts\python.exe -m uvicorn app.main:app --host $BindHost --port $BindPort --reload
