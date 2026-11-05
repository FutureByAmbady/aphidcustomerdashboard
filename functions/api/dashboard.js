const DETECTION_COLUMNS = '*';
const TELEMETRY_COLUMNS = 'id,device_id,recorded_at,wind_direction,wind_angle,previous_position,target_position,motor_direction,movement,required_pulses,actual_pulses,final_position,status,battery_percent,battery_voltage';

function envValue(env, ...names) {
  for (const name of names) {
    if (env[name]) return String(env[name]).trim();
  }
  return '';
}

function parseTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function integerCount(value) {
  const count = Number.parseInt(value ?? 0, 10);
  return Number.isFinite(count) ? Math.max(0, count) : 0;
}

function localDateKey(value, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

function localMidnight(dateKey, timezone) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(candidate).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = Number(part.value);
    return result;
  }, {});
  const displayedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return new Date(candidate.getTime() - (displayedAsUtc - candidate.getTime()));
}

function shiftDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function publicImageUrl(value, supabaseUrl, bucket) {
  if (!value) return null;
  const text = String(value).trim();
  if (/^https?:\/\//i.test(text)) return text;
  return `${supabaseUrl}/storage/v1/object/public/${bucket}/${text.split('/').map(encodeURIComponent).join('/')}`;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function querySupabase(env, table, params) {
  const supabaseUrl = envValue(env, 'SUPABASE_URL');
  const supabaseKey = envValue(env, 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'SUPABASE_KEY');
  if (!supabaseUrl || !supabaseKey) throw new Error('Supabase is not configured.');
  const response = await fetch(`${supabaseUrl}/rest/v1/${table}?${params.toString()}`, {
    headers: {
      apikey: supabaseKey,
      ...(supabaseKey.startsWith('sb_') ? {} : { Authorization: `Bearer ${supabaseKey}` }),
    },
  });
  if (!response.ok) { const error = new Error('Data source unavailable.'); error.status = response.status; throw error; }
  return response.json();
}

function imageEnvironment(env) {
  const url = envValue(env, 'IMAGE_SUPABASE_URL');
  const key = envValue(env, 'IMAGE_SUPABASE_SECRET_KEY');
  // Partial IMAGE_* configuration must fail rather than mix old/new credentials.
  return url || key ? { SUPABASE_URL: url, SUPABASE_KEY: key } : env;
}

export async function queryWind(env, params) {
  return querySupabase({ SUPABASE_URL: envValue(env, 'WIND_SUPABASE_URL'),
    SUPABASE_KEY: envValue(env, 'WIND_SUPABASE_SECRET_KEY') }, 'wind_operation_logs', params);
}

export function windBounds(startDate, endDate, timezone = 'Asia/Kolkata') {
  const today = localDateKey(new Date(), timezone);
  const first = startDate || shiftDateKey(today, -6);
  const last = endDate || today;
  const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!valid(first) || !valid(last) || first < '1900-01-01' || first > last || (Date.parse(last) - Date.parse(first)) / 86400000 > 365 || last === '9999-12-31') {
    throw new Error('Wind date range must use YYYY-MM-DD, start in 1900 or later, be ordered and no longer than 366 days.');
  }
  return [localMidnight(first, timezone), localMidnight(shiftDateKey(last, 1), timezone)];
}

export async function windPage(env, deviceId, start, end, offset, limit) {
  const params = new URLSearchParams({ select: '*',
    recorded_at: 'gte.' + start.toISOString(), order: 'recorded_at.desc.nullslast,id.desc',
    offset: String(offset), limit: String(limit + 1) });
  if (deviceId) params.set('device_id', 'eq.' + deviceId);
  params.append('recorded_at', 'lt.' + end.toISOString());
  const rows = await queryWind(env, params);
  if (!Array.isArray(rows)) throw new Error('Unexpected wind response.');
  return { rows: rows.slice(0, limit).map(row => Object.fromEntries(TELEMETRY_COLUMNS.split(',').map(key => [key, row[key] ?? null]))), has_more: rows.length > limit, offset, limit, source: 'wind_operation_logs' };
}

export async function windDevices(env) {
  const devices = new Set();
  let offset = 0;
  while (true) {
    const rows = await queryWind(env, new URLSearchParams({ select: 'device_id', order: 'device_id.asc,id.asc', offset: String(offset), limit: '1000' }));
    if (!Array.isArray(rows)) throw new Error('Unexpected wind device response.');
    rows.forEach(row => { if (row.device_id) devices.add(row.device_id); });
    if (rows.length < 1000) break;
    offset += rows.length;
  }
  return [...devices].sort();
}

function activitySummary(currentRows, previousRows) {
  const currentTotal = currentRows.reduce((sum, row) => sum + integerCount(row.insect_count), 0);
  const previousTotal = previousRows.reduce((sum, row) => sum + integerCount(row.insect_count), 0);
  if (!currentRows.length || !previousRows.length || previousTotal === 0) {
    return { label: 'Not enough data', direction: 'unknown', percentage: null, current_total: currentTotal, previous_total: previousTotal };
  }
  const percentage = Math.round(((currentTotal - previousTotal) / previousTotal) * 1000) / 10;
  return {
    label: percentage > 0 ? 'Increasing' : percentage < 0 ? 'Decreasing' : 'Stable',
    direction: percentage > 0 ? 'up' : percentage < 0 ? 'down' : 'stable',
    percentage,
    current_total: currentTotal,
    previous_total: previousTotal,
  };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const period = Math.min(30, Math.max(1, Number.parseInt(url.searchParams.get('period') || '7', 10) || 7));
  const historyOffset = Math.max(0, Number.parseInt(url.searchParams.get('history_offset') || '0', 10) || 0);
  const historyLimit = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get('history_limit') || '5', 10) || 5));
  const windOffset = Math.max(0, Number.parseInt(url.searchParams.get('wind_offset') || '0', 10) || 0);
  const windLimit = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get('wind_limit') || '5', 10) || 5));
  const timezone = envValue(env, 'DASHBOARD_TIMEZONE') || 'Asia/Kolkata';
  const deviceId = envValue(env, 'DASHBOARD_DEVICE_ID') || 'PI5-001';
  const trapName = envValue(env, 'DASHBOARD_TRAP_NAME') || 'Trap 001';
  const bucket = envValue(env, 'SUPABASE_BUCKET', 'SUPABASE_STORAGE_BUCKET') || 'monitoring-images';
  const now = new Date();
  const todayKey = localDateKey(now, timezone);
  const currentStartKey = shiftDateKey(todayKey, -(period - 1));
  const previousStartKey = shiftDateKey(currentStartKey, -period);
  const currentStart = localMidnight(currentStartKey, timezone);
  const previousStart = localMidnight(previousStartKey, timezone);
  const tomorrowStart = localMidnight(shiftDateKey(todayKey, 1), timezone);
  const imageEnv = imageEnvironment(env);
  const supabaseUrl = envValue(imageEnv, 'SUPABASE_URL');

  try {
    const detectionParams = new URLSearchParams({
      select: DETECTION_COLUMNS,
      device_id: `eq.${deviceId}`,
      captured_at: `gte.${previousStart.toISOString()}`,
      order: 'captured_at.desc',
      limit: envValue(env, 'MAX_DETECTIONS') || '5000',
    });
    detectionParams.append('captured_at', `lt.${tomorrowStart.toISOString()}`);
    let rows = [];
    let imageWarning = null;
    try { rows = await querySupabase(imageEnv, 'detections', detectionParams); if (!Array.isArray(rows)) throw new Error('Invalid image data.'); }
    catch (error) { imageWarning = error.status === 402
      ? 'Image history is inaccessible: the image database has an HTTP 402 egress restriction. Wind history remains available.'
      : 'Image history is temporarily unavailable. Image migration or server configuration must be verified; wind history remains available.'; }
    const validRows = rows.filter((row) => parseTimestamp(row.captured_at));
    const currentRows = validRows.filter((row) => parseTimestamp(row.captured_at) >= currentStart);
    const previousRows = validRows.filter((row) => parseTimestamp(row.captured_at) < currentStart);
    const counts = {};
    for (const row of currentRows) {
      const key = localDateKey(parseTimestamp(row.captured_at), timezone);
      counts[key] = (counts[key] || 0) + integerCount(row.insect_count);
    }
    const publicRow = (row) => {
      const resultUrl = publicImageUrl(row.result_image_url, supabaseUrl, bucket);
      const originalUrl = publicImageUrl(row.original_image_url, supabaseUrl, bucket);
      return {
        id: row.id ?? null,
        device_id: row.device_id,
        session_id: row.session_id ?? row.capture_session_id ?? null,
        average_confidence: row.average_confidence ?? null,
        processing_status: row.processing_status ?? null,
        captured_at: parseTimestamp(row.captured_at)?.toISOString() || null,
        insect_count: integerCount(row.insect_count),
        result_image_url: resultUrl,
        original_image_url: originalUrl,
        image_url: resultUrl || originalUrl,
        image_available: Boolean(resultUrl || originalUrl),
      };
    };
    const historyRows = currentRows.slice(historyOffset, historyOffset + historyLimit).map(publicRow);
    const latest = validRows.length ? publicRow(validRows[0]) : null;
    const todayRows = validRows.filter((row) => localDateKey(parseTimestamp(row.captured_at), timezone) === todayKey);

    let windResult = { rows: [], has_more: false };
    const windWarnings = [];
    let latestEvent = null;
    try {
      windResult = await windPage(env, deviceId, currentStart, tomorrowStart, windOffset, windLimit);
      const latestRows = await queryWind(env, new URLSearchParams({ select: '*', device_id: 'eq.' + deviceId, order: 'recorded_at.desc.nullslast,id.desc', limit: '1' }));
      latestEvent = latestRows[0] || null;
    } catch { windWarnings.push('Wind operation logs could not be loaded.'); }
    const windHistory = windResult.rows;
    const latestWind = latestEvent;
    const recordedAt = parseTimestamp(latestEvent?.recorded_at);
    const fields = {};
    for (const key of ['battery_percent', 'battery_voltage', 'status']) {
      if (latestEvent?.[key] !== null && latestEvent?.[key] !== undefined) fields[key] = latestEvent[key];
    }
    for (const key of ['wind_direction', 'wind_angle']) {
      if (latestWind?.[key] !== null && latestWind?.[key] !== undefined) fields[key] = latestWind[key];
    }

    return json({
      trap_name: trapName,
      device_id: deviceId,
      timezone,
      generated_at: now.toISOString(),
      period_days: period,
      image_warning: imageWarning,
      image_records: currentRows.map(publicRow),
      image_records_truncated: rows.length >= Number(envValue(env, 'MAX_DETECTIONS') || '5000'),
      kpis: {
        aphids_today: imageWarning ? null : todayRows.reduce((sum, row) => sum + integerCount(row.insect_count), 0),
        images_today: imageWarning ? null : todayRows.length,
        activity: imageWarning ? { label: 'Unavailable', percentage: null, direction: 'unknown' } : activitySummary(currentRows, previousRows),
        last_detection: latest,
      },
      trend: Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count })),
      wind_history: windHistory,
      wind_history_warning: windWarnings.length ? windWarnings.join(' ') : null,
      wind_history_offset: windOffset,
      wind_history_limit: windLimit,
      wind_history_has_more: windResult.has_more,
      latest_detection: latest,
      recent_detections: historyRows,
      history_offset: historyOffset,
      history_limit: historyLimit,
      history_has_more: historyOffset + historyLimit < currentRows.length,
      health: {
        available: Boolean(latestEvent),
        status: 'unknown',
        last_communication: null,
        last_operation: recordedAt?.toISOString() || null,
        note: 'Historical operation data does not establish device connectivity.',
        fields,
      },
    });
  } catch (error) {
    return json({ detail: 'Unable to load monitoring data right now.' }, 502);
  }
}
