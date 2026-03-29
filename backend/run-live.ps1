param(
    [Parameter(Mandatory = $true)]
    [string]$CvpHost,

    [Parameter(Mandatory = $true)]
    [string]$Username,

    [Parameter(Mandatory = $true)]
    [string]$Password,

    [int]$CvpPort = 443,
    [string]$BindHost = '127.0.0.1',
    [int]$BindPort = 8000,
    [switch]$InsecureTls
)

$env:OPS_CONSOLE_USE_MOCK = 'false'
$env:CVP_HOST = $CvpHost
$env:CVP_PORT = [string]$CvpPort
$env:CVP_USERNAME = $Username
$env:CVP_PASSWORD = $Password
$env:CVP_INSECURE_TLS = if ($InsecureTls) { 'true' } else { 'false' }

& .\.venv\Scripts\python.exe -m uvicorn app.main:app --host $BindHost --port $BindPort --reload
