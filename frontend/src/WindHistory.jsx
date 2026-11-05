import { useEffect, useState } from "react";

const display = value => value == null || value === '' ? '—' : value;
function outcomeTone(value) {
  const status = String(value || '').toUpperCase();
  if (/FAIL|ERROR|TIMEOUT|ABORT|STALL|SENSOR_NO_DATA/.test(status)) return 'failure';
  if (/SUCCESS|COMPLETE|OK/.test(status)) return 'normal';
  return 'neutral';
}

export default function WindHistory({ apiBase, timezone = 'Asia/Kolkata' }) {
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState({ rows: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const limit = 5;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit), customer_view: 'true' });
    fetch(apiBase + '/api/wind?' + params, { signal: controller.signal })
      .then(async response => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.detail || 'Unable to load wind operation logs.');
        if (controller.signal.aborted) return;
        setData(current => offset === 0 ? payload : {
          ...payload,
          rows: [...new Map([...current.rows, ...payload.rows].map(row =>
            [row.id ?? `${row.device_id}:${row.recorded_at}`, row])).values()],
        });
      })
      .catch(error => { if (error.name !== 'AbortError' && !controller.signal.aborted) setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [apiBase, offset, retry]);
  return <section className="panel wind-history-panel" aria-label="Wind operation history">
    <div className="panel-heading"><h3>Wind history</h3></div>
    {error && <div className="alert error-alert" role="alert">{error}<button className="text-button" onClick={() => setRetry(value => value + 1)}>Retry wind history</button></div>}
    {data.warning && <p role="status">{data.warning}</p>}
    {loading && offset === 0 ? <div className="empty-state" role="status">Loading wind operations…</div> : (!data.rows.length ? <div className="empty-state">No wind readings available.</div> : <>
      <div className="wind-table-wrap"><table className="wind-table wind-operation-table">
        <thead><tr><th>Time / device</th><th>Wind</th><th>Battery</th><th>Outcome</th></tr></thead>
        <tbody>{data.rows.map((row, index) => <tr key={row.id ?? index}>
          <td><strong>{row.recorded_at ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(row.recorded_at)) : '—'}</strong><span className="table-muted">{display(row.device_id)}</span></td>
          <td>{display(row.wind_direction)}<span className="table-muted">{row.wind_angle == null ? '—' : row.wind_angle + '°'}</span></td>
          <td>{row.battery_percent == null ? '—' : row.battery_percent + '%'}<span className="table-muted">{row.battery_voltage == null ? '—' : row.battery_voltage + ' V'}</span></td>
          <td><span className={'telemetry-label telemetry-' + outcomeTone(row.status)}>{display(row.status)}</span></td>
        </tr>)}</tbody>
      </table></div>
    </>)}
    {(data.has_more || loading) && <div className="history-more wind-pagination"><button className="secondary-button" disabled={loading || !!error} onClick={() => setOffset(value => value + limit)}>{loading ? 'Loading wind readings…' : 'Read more'}</button></div>}

  </section>;
}
