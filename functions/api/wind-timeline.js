// Read-only, recorded-time fallback. No synthetic measurements or time slots.
const HOUR = 3600000;
const IST = 19800000;
const PAGE = 100;
const MAX_PAGES = 50;
const DIRECTIONS = new Set(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'H']);
export function normalizeWindRow(row, source) {
  if (!row?.device_id || !row.recorded_at || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(row.recorded_at)) return null;
  const stamp = Date.parse(row.recorded_at);
  if (!Number.isFinite(stamp)) return null;
  const angle = row.wind_angle;
  const validAngle = angle !== null && angle !== undefined && angle !== '' && typeof angle !== 'boolean' && Number.isFinite(Number(angle)) && Number(angle) >= 0 && Number(angle) <= 360;
  const meaningfulOperation = source === 'wind_operation_logs' && !['', '-', 'UNKNOWN'].includes(String(row.status || '').trim().toUpperCase());
  if (!validAngle && !DIRECTIONS.has(String(row.wind_direction || '').trim().toUpperCase()) && !meaningfulOperation) return null;
  return { ...row, wind_angle: validAngle ? angle : null, source,
    source_label: source === 'wind_data' ? 'Wind Data' : 'Operation Log',
    record_kind: source === 'wind_data' ? 'measurement' : 'operation',
    period_start: new Date(Math.floor((stamp + IST) / HOUR) * HOUR - IST).toISOString() };
}
export function windTimeBounds(start, end, startAt, endAt) {
  const parse = value => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Receipt time filters require valid ISO timestamps with timezone offsets.');
    return new Date(value);
  };
  const first = startAt ? parse(startAt) : start;
  const last = endAt ? parse(endAt) : end;
  if ((start && first && first < start) || (end && last && last > end) ||
      (first && last && (first >= last || last - first > 366 * 86400000))) throw new Error('Receipt time range must be ordered, inside the date range, and at most 366 days.');
  return [first, last];
}
export async function combinedWindPage(load, deviceId, start, end, offset, limit, columns) {
  const warnings = [];
  let quota = false, truncated = false;
  const streams = ['wind_data', 'wind_operation_logs'].map(source => {
    let buffer = [], index = 0, rawOffset = 0, pages = 0, done = false, failed = false;
    return { source, get failed() { return failed; }, async next() {
      while (true) {
        if (index < buffer.length) {
          const raw = buffer[index++];
          const row = normalizeWindRow(raw, source);
          if (!row) continue;
          const time = Date.parse(row.recorded_at);
          if ((deviceId && row.device_id !== deviceId) || (start && time < start.getTime()) || (end && time >= end.getTime())) continue;
          return row;
        }
        if (done || quota) return null;
        if (pages >= MAX_PAGES) {
          truncated = true; warnings.push(`${source}: scan limit reached; narrow the recorded-time range.`); done = true; return null;
        }
        try {
          const rows = await load(source, rawOffset, PAGE, columns, deviceId, start, end);
          if (!Array.isArray(rows)) throw new Error('Invalid wind response');
          pages++; rawOffset += rows.length; buffer = rows; index = 0; done = rows.length < PAGE;
        } catch (error) {
          failed = true; done = true;
          quota = Number(error?.status ?? error?.code) === 402 || /exceed_egress_quota/i.test(String(error));
          warnings.push(`${source} unavailable${quota ? ' (quota restricted; no further source requests)' : ''}.`);
          return null;
        }
      }
    } };
  });
  // Primary first; a quota response must not trigger another request to the same project.
  const heads = [await streams[0].next(), null];
  heads[1] = await streams[1].next();
  const merged = [];
  const needed = offset + limit + 1;
  while ((heads[0] || heads[1]) && merged.length < needed) {
    const period = [heads[0]?.period_start, heads[1]?.period_start].filter(Boolean).sort().at(-1);
    const primary = [], fallback = new Map(), seen = new Set();
    for (let i = 0; i < streams.length; i++) {
      while (heads[i]?.period_start === period) {
        const row = heads[i];
        if (i === 0) {
          const key = JSON.stringify([row.device_id, Date.parse(row.recorded_at)]);
          if (!seen.has(key)) { primary.push(row); seen.add(key); }
        } else if (!fallback.has(row.device_id)) fallback.set(row.device_id, row);
        heads[i] = await streams[i].next();
      }
    }
    const primaryDevices = new Set(primary.map(row => row.device_id));
    const selected = [...primary, ...[...fallback.values()].filter(row => !primaryDevices.has(row.device_id))];
    merged.push(...selected.sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at) || String(a.device_id).localeCompare(String(b.device_id))));
  }
  const priorityUnverified = streams[0].failed || truncated;
  if (streams[0].failed && merged.some(row => row.source === 'wind_operation_logs')) warnings.push('Primary source could not be fully verified; operation records are provisional fallback.');
  return { rows: merged.slice(offset, offset + limit).map(row => ({ ...row, ...(row.source === 'wind_operation_logs' && priorityUnverified ? { priority_unverified: true } : {}) })),
    has_more: merged.length > offset + limit, offset, limit, source: 'wind_data',
    sources: ['wind_data', 'wind_operation_logs'], period_minutes: 60, timestamp_field: 'recorded_at',
    timezone: 'Asia/Kolkata', truncated, partial: streams.some(stream => stream.failed),
    warning: warnings.length ? [...new Set(warnings)].join(' ') : null };
}
