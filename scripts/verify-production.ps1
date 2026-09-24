$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'

if (!(Test-Path -LiteralPath $envFile)) {
    throw 'Missing .env. Copy .env.example and configure the deployment environment.'
}

$required = @('SUPABASE_URL', 'SUPABASE_BUCKET', 'DASHBOARD_DEVICE_ID', 'DASHBOARD_TIMEZONE', 'CORS_ORIGINS', 'VITE_API_BASE_URL')
$values = @{}
Get-Content -LiteralPath $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#=][^=]*)=(.*)$') { $values[$matches[1].Trim()] = $matches[2].Trim() }
}

foreach ($name in $required) {
    if (!$values.ContainsKey($name) -or [string]::IsNullOrWhiteSpace($values[$name])) {
        throw "Missing required configuration: $name"
    }
}

if (!$values.ContainsKey('SUPABASE_SERVICE_ROLE_KEY') -and !$values.ContainsKey('SUPABASE_ANON_KEY') -and !$values.ContainsKey('SUPABASE_KEY')) {
    throw 'Set SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY in the server environment.'
}

Write-Output 'Required deployment configuration is present; secret values were not printed.'
