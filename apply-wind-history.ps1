$ErrorActionPreference = 'Stop'
$root = 'C:\SmartInsectDetector\AphidCustomerDashboard'
$files = @(
  'frontend\src\App.jsx',
  'frontend\src\styles.css',
  'functions\api\dashboard.js'
)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($file in $files) { Copy-Item (Join-Path $root $file) (Join-Path $root ($file + '.backup-' + $stamp)) -Force }

$app = Join-Path $root 'frontend\src\App.jsx'
$text = [IO.File]::ReadAllText($app)
$old = @'
      <RecentDetections rows={data.recent_detections || []} timezone={data.timezone} hasMore={data.history_has_more} onLoadMore={onLoadMore} loadingMore={loadingMore} />
'@
$new = @'
      <WindHistory rows={data.wind_history || []} timezone={data.timezone} period={period} />

      <RecentDetections rows={data.recent_detections || []} timezone={data.timezone} hasMore={data.history_has_more} onLoadMore={onLoadMore} loadingMore={loadingMore} />
'@
if (!$text.Contains($old)) { throw 'App.jsx insertion point not found.' }
$text = $text.Replace($old, $new)
$old = 'function RecentDetections({ rows, timezone, hasMore, onLoadMore, loadingMore }) {'
$new = @'
function WindHistory({ rows, timezone, period }) {
  return (
    <section className="panel wind-history-panel">
      <div className="panel-heading"><div><p className="eyebrow">Device telemetry</p><h3>Wind history</h3></div><span className="wind-history-note">Last {period === 1 ? "day" : `${period} days`}</span></div>
      {!rows.length ? <EmptyState message="No wind readings available for this period." /> : (
        <div className="wind-table-wrap">
          <table className="wind-table">
            <thead><tr><th>Time</th><th>Direction</th><th>Angle</th><th>Battery</th><th>Voltage</th></tr></thead>
            <tbody>{rows.map((row, index) => <tr key={`${row.recorded_at}-${index}`}><td><strong>{formatDate(row.recorded_at, timezone)}</strong><span className="table-muted">{relativeTime(row.recorded_at)}</span></td><td>{row.wind_direction || "—"}</td><td>{row.wind_angle == null ? "—" : `${row.wind_angle}°`}</td><td>{row.battery_percent == null ? "—" : `${row.battery_percent}%`}</td><td>{row.battery_voltage == null ? "—" : `${row.battery_voltage} V`}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RecentDetections({ rows, timezone, hasMore, onLoadMore, loadingMore }) {
'@
if (!$text.Contains($old)) { throw 'RecentDetections insertion point not found.' }
$text = $text.Replace($old, $new)
[IO.File]::WriteAllText($app, $text)

$css = Join-Path $root 'frontend\src\styles.css'
$text = [IO.File]::ReadAllText($css)
$marker = '.recent-panel {'
$insert = '.wind-history-panel { margin-bottom: 18px; }.wind-history-note { color: #8a978d; font-size: 12px; }.wind-table-wrap { overflow-x: auto; }.wind-table { width: 100%; min-width: 560px; border-collapse: collapse; font-size: 12px; }.wind-table th { padding: 0 12px 10px; color: #8a978d; font-size: 10px; font-weight: 700; letter-spacing: .08em; text-align: left; text-transform: uppercase; }.wind-table td { padding: 12px; border-top: 1px solid #edf1ed; color: #506157; white-space: nowrap; }.wind-table td strong, .table-muted { display: block; }.wind-table td strong { color: #334b39; font-size: 12px; font-weight: 600; }.table-muted { margin-top: 3px; color: #94a098; font-size: 10px; }.wind-table th:first-child, .wind-table td:first-child { padding-left: 0; }.wind-table th:last-child, .wind-table td:last-child { padding-right: 0; text-align: right; }'
if (!$text.Contains($marker)) { throw 'styles.css insertion point not found.' }
$text = $text.Replace($marker, $insert + $marker)
[IO.File]::WriteAllText($css, $text)

$api = Join-Path $root 'functions\api\dashboard.js'
$text = [IO.File]::ReadAllText($api)
$old = @'
    const telemetryParams = new URLSearchParams({
      select: TELEMETRY_COLUMNS,
      device_id: `eq.${deviceId}`,
      order: 'recorded_at.desc',
      limit: '1',
    });
    const telemetryRows = await querySupabase(env, 'wind_data', telemetryParams);
    const telemetry = telemetryRows[0];
'@
$new = @'
    const telemetryParams = new URLSearchParams({
      select: TELEMETRY_COLUMNS,
      device_id: `eq.${deviceId}`,
      recorded_at: `gte.${currentStart.toISOString()}`,
      order: 'recorded_at.desc',
      limit: envValue(env, 'MAX_WIND_HISTORY') || '200',
    });
    telemetryParams.append('recorded_at', `lt.${tomorrowStart.toISOString()}`);
    const telemetryRows = await querySupabase(env, 'wind_data', telemetryParams);
    const telemetry = telemetryRows[0];
    const windHistory = telemetryRows.filter((row) => parseTimestamp(row.recorded_at)).map((row) => ({
      recorded_at: parseTimestamp(row.recorded_at).toISOString(),
      wind_direction: row.wind_direction ?? null,
      wind_angle: row.wind_angle ?? null,
      battery_percent: row.battery_percent ?? null,
      battery_voltage: row.battery_voltage ?? null,
    }));
'@
if (!$text.Contains($old)) { throw 'dashboard.js telemetry block not found.' }
$text = $text.Replace($old, $new)
$old = '      trend: Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count })),'
$new = $old + "`r`n      wind_history: windHistory,"
if (!$text.Contains($old)) { throw 'dashboard.js response insertion point not found.' }
$text = $text.Replace($old, $new)
[IO.File]::WriteAllText($api, $text)

Set-Location $root
npm --prefix frontend run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
Write-Host "Wind history applied and build passed. Backups use suffix: $stamp" -ForegroundColor Green
 git status --short