import { useEffect, useState } from "react";

function dateKey(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
const display = value => value == null || value === '' ? '—' : value;
function outcomeTone(value) {
  const status = String(value || '').toUpperCase();
  if (/FAIL|ERROR|TIMEOUT|ABORT|STALL|SENSOR_NO_DATA/.test(status)) return 'failure';
  if (/SUCCESS|COMPLETE|OK/.test(status)) return 'normal';
  return 'neutral';
}

export default function WindHistory({ apiBase, timezone = 'Asia/Kolkata' }) {
  const [filters, setFilters] = useState(() => {
    const now = new Date();
    const first = new Date(now.getTime() - 6 * 86400000);
    return { device_id: '', start_date: dateKey(first, timezone), end_date: dateKey(now, timezone) };
  });
  const [applied, setApplied] = useState(filters);
  const [offset, setOffset] = useState(0);
  const [devices, setDevices] = useState([]);
  const [data, setData] = useState({ rows: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const limit = 20;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    const params = new URLSearchParams({ ...applied, offset: String(offset), limit: String(limit), include_devices: 'true' });
    fetch(apiBase + '/api/wind?' + params, { signal: controller.signal })
      .then(async response => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.detail || 'Unable to load wind operation logs.');
        if (controller.signal.aborted) return;
        setData(payload);
        if (payload.devices) setDevices(payload.devices);
      })
      .catch(error => { if (error.name !== 'AbortError' && !controller.signal.aborted) setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [apiBase, applied, offset, retry]);
  const update = event => setFilters(current => ({ ...current, [event.target.name]: event.target.value }));
  return <section className="panel wind-history-panel" aria-label="Wind operation history">
    <div className="panel-heading"><div><p className="eyebrow">Device telemetry</p><h3>Wind &amp; device history</h3></div></div>
    <form className="wind-filters" onSubmit={event => { event.preventDefault(); setOffset(0); setApplied({ ...filters }); }}>
      <label>Wind device<select name="device_id" value={filters.device_id} onChange={update}><option value="">All wind devices</option>{devices.map(device => <option key={device} value={device}>{device}</option>)}</select></label>
      <label>From<input name="start_date" aria-label="Wind start date" type="date" required value={filters.start_date} onChange={update} /></label>
      <label>To<input name="end_date" aria-label="Wind end date" type="date" required min={filters.start_date} value={filters.end_date} onChange={update} /></label>
      <button className="secondary-button" type="submit" disabled={loading}>Apply</button>
    </form>
    <p className="wind-source-note">Source: wind_operation_logs · All outcomes, including failed operations · {timezone}</p>
    {error && <div className="alert error-alert" role="alert">{error}<button className="text-button" onClick={() => setRetry(value => value + 1)}>Retry wind history</button></div>}
    {data.warning && <p role="status">{data.warning}</p>}
    {loading ? <div className="empty-state" role="status">Loading wind operations…</div> : !error && (!data.rows.length ? <div className="empty-state">No wind operations for these filters.</div> : <>
      <div className="wind-table-wrap"><table className="wind-table wind-operation-table">
        <thead><tr><th>Time / device</th><th>Wind</th><th>Position</th><th>Motor / movement</th><th>Pulses</th><th>Battery</th><th>Outcome</th></tr></thead>
        <tbody>{data.rows.map((row, index) => <tr key={row.id ?? index}>
          <td><strong>{row.recorded_at ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(row.recorded_at)) : '—'}</strong><span className="table-muted">{display(row.device_id)}</span></td>
          <td>{display(row.wind_direction)}<span className="table-muted">{row.wind_angle == null ? '—' : row.wind_angle + '°'}</span></td>
          <td>Target: {display(row.target_position)}<span className="table-muted">Final: {display(row.final_position)} · Previous: {display(row.previous_position)}</span></td>
          <td>{display(row.motor_direction)}<span className="table-muted">Movement: {display(row.movement)}</span></td>
          <td>Required: {display(row.required_pulses)}<span className="table-muted">Actual: {display(row.actual_pulses)}</span></td>
          <td>{row.battery_percent == null ? '—' : row.battery_percent + '%'}<span className="table-muted">{row.battery_voltage == null ? '—' : row.battery_voltage + ' V'}</span></td>
          <td><span className={'telemetry-label telemetry-' + outcomeTone(row.status)}>{display(row.status)}</span></td>
        </tr>)}</tbody>
      </table></div>
    </>)}
    <div className="history-more wind-pagination"><button className="secondary-button" disabled={loading || offset === 0} onClick={() => setOffset(value => Math.max(0, value - limit))}>Previous wind page</button><span>Page {Math.floor(offset / limit) + 1}</span><button className="secondary-button" disabled={loading || !!error || !data.has_more} onClick={() => setOffset(value => value + limit)}>Next wind page</button></div>
  </section>;
}
