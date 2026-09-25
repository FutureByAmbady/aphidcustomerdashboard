from pathlib import Path
import shutil
from datetime import datetime

root = Path(r'C:\SmartInsectDetector\AphidCustomerDashboard')
stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
app = root / 'frontend/src/App.jsx'
css = root / 'frontend/src/styles.css'
api = root / 'functions/api/dashboard.js'
for p in (app, css, api):
    shutil.copy2(p, Path(str(p) + f'.backup-{stamp}'))

def read(p):
    return p.read_text(encoding='utf-8-sig').replace('\r\n', '\n')
def write(p, s):
    p.write_text(s, encoding='utf-8', newline='\n')

s = read(app)
old = '  const [loadingMore, setLoadingMore] = useState(false);\n'
new = old + '  const [loadingMoreWind, setLoadingMoreWind] = useState(false);\n'
assert old in s, 'loading state marker not found'
s = s.replace(old, new, 1)
marker = '  useEffect(() => {\n'
fn = '''  const loadMoreWindHistory = useCallback(async () => {
    if (!data?.wind_history_has_more || loadingMoreWind) return;
    setLoadingMoreWind(true);
    try {
      const offset = data.wind_history?.length || 0;
      const response = await fetch(`${API_BASE_URL}/api/dashboard?period=${period}&wind_offset=${offset}&wind_limit=5`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || "Unable to load more wind history.");
      setData((current) => ({
        ...current,
        ...payload,
        wind_history: [...(current?.wind_history || []), ...(payload.wind_history || [])],
      }));
    } catch (requestError) {
      setError(requestError.message || "Unable to load more wind history.");
    } finally {
      setLoadingMoreWind(false);
    }
  }, [data, loadingMoreWind, period]);

'''
assert marker in s, 'effect marker not found'
s = s.replace(marker, fn + marker, 1)
old = '        {data && <Dashboard data={data} period={period} setPeriod={setPeriod} onLoadMore={loadMoreHistory} loadingMore={loadingMore} />}\n'
new = '        {data && <Dashboard data={data} period={period} setPeriod={setPeriod} onLoadMore={loadMoreHistory} loadingMore={loadingMore} onLoadMoreWind={loadMoreWindHistory} loadingMoreWind={loadingMoreWind} />}\n'
assert old in s, 'Dashboard render not found'
s = s.replace(old, new, 1)
old = 'function Dashboard({ data, period, setPeriod, onLoadMore, loadingMore }) {'
new = 'function Dashboard({ data, period, setPeriod, onLoadMore, loadingMore, onLoadMoreWind, loadingMoreWind }) {'
assert old in s, 'Dashboard signature not found'
s = s.replace(old, new, 1)
old = '''      <WindHistory rows={data.wind_history || []} timezone={data.timezone} period={period} />

      <RecentDetections rows={data.recent_detections || []} timezone={data.timezone} hasMore={data.history_has_more} onLoadMore={onLoadMore} loadingMore={loadingMore} />
'''
new = '''      <section className="history-grid">
        <RecentDetections rows={data.recent_detections || []} timezone={data.timezone} hasMore={data.history_has_more} onLoadMore={onLoadMore} loadingMore={loadingMore} />
        <WindHistory rows={data.wind_history || []} timezone={data.timezone} period={period} hasMore={data.wind_history_has_more} onLoadMore={onLoadMoreWind} loadingMore={loadingMoreWind} />
      </section>
'''
assert old in s, 'history render block not found'
s = s.replace(old, new, 1)
old = 'function WindHistory({ rows, timezone, period }) {'
new = 'function WindHistory({ rows, timezone, period, hasMore, onLoadMore, loadingMore }) {'
assert old in s, 'WindHistory signature not found'
s = s.replace(old, new, 1)
old = '''          </table>
        </div>
      )}
    </section>
  );
}

function RecentDetections'''
new = '''          </table>
        </div>
        {hasMore && <div className="history-more"><button className="secondary-button" onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? "Loading…" : "Show more"}</button></div>}
      )}
    </section>
  );
}

function RecentDetections'''
assert old in s, 'WindHistory table ending not found'
s = s.replace(old, new, 1)
write(app, s)

s = read(css)
marker = '.wind-history-panel {'
insert = '.history-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; align-items: start; margin-bottom: 18px; }.history-grid .panel { margin-bottom: 0; min-width: 0; }'
assert marker in s, 'CSS history marker not found'
s = s.replace(marker, insert + marker, 1)
marker = '@media (max-width: 900px) {'
assert marker in s, 'CSS media marker not found'
s = s.replace(marker, marker + ' .history-grid { grid-template-columns: 1fr; }', 1)
write(css, s)

s = read(api)
old = "  const historyLimit = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get('history_limit') || '5', 10) || 5));\n"
new = old + "  const windOffset = Math.max(0, Number.parseInt(url.searchParams.get('wind_offset') || '0', 10) || 0);\n  const windLimit = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get('wind_limit') || '5', 10) || 5));\n"
assert old in s, 'API pagination marker not found'
s = s.replace(old, new, 1)
old = "      limit: envValue(env, 'MAX_WIND_HISTORY') || '200',\n"
new = "      limit: String(Math.min(5000, windOffset + windLimit + 1)),\n"
assert old in s, 'API wind limit not found'
s = s.replace(old, new, 1)
old = "    const windHistory = telemetryRows.filter((row) => parseTimestamp(row.recorded_at)).map((row) => ({\n"
new = "    const windPageRows = telemetryRows.slice(windOffset, windOffset + windLimit);\n    const windHistory = windPageRows.filter((row) => parseTimestamp(row.recorded_at)).map((row) => ({\n"
assert old in s, 'API wind mapping not found'
s = s.replace(old, new, 1)
old = '      wind_history: windHistory,\n'
new = old + '      wind_history_offset: windOffset,\n      wind_history_limit: windLimit,\n      wind_history_has_more: telemetryRows.length > windOffset + windLimit,\n'
assert old in s, 'API response marker not found'
s = s.replace(old, new, 1)
write(api, s)

print('Updated two-column history layout with independent pagination.')
print('Backups:', stamp)
