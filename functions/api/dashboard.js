const DETECTION_COLUMNS = 'device_id,captured_at,insect_count,result_image_url,original_image_url';
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
      Authorization: `Bearer ${supabaseKey}`,
    },
  });
  if (!response.ok) throw new Error(`Supabase request failed with ${response.status}.`);
  return response.json();
}

const WIND_PAGE_SIZE = 500;
const COMPASS_DIRECTIONS = new Set(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);
const WIND_HISTORY_COLUMNS = ['recorded_at', 'wind_direction', 'wind_angle', 'previous_position', 'target_position', 'motor_direction', 'movement', 'required_pulses', 'actual_pulses', 'final_position', 'status', 'battery_percent', 'battery_voltage'];

function normalizeTelemetryCode(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function isValidWindReading(row) {
  const direction = normalizeTelemetryCode(row.wind_direction);
  const status = normalizeTelemetryCode(row.status);
  const angle = row.wind_angle;
  return COMPASS_DIRECTIONS.has(direction)
    && !['DAILY_HOME', 'POWER_FAIL_HOME', 'POWER_FAILURE_HOME'].includes(status)
    && angle !== null
    && angle !== undefined
    && angle !== ''
    && Number.isFinite(Number(angle))
    && Number(angle) >= 0
    && Number(angle) <= 360;
}

function hourlySlotKey(value, timezone) {
  const timestamp = parseTimestamp(value);
  if (!timestamp) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(timestamp).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`;
}

function windEventKey(row) {
  const timestamp = parseTimestamp(row.recorded_at);
  return JSON.stringify([
    row.device_id ?? '', timestamp?.toISOString() ?? '',
    normalizeTelemetryCode(row.wind_direction), row.wind_angle == null || row.wind_angle === '' ? null : Number(row.wind_angle),
    normalizeTelemetryCode(row.status), row.previous_position ?? null, row.target_position ?? null,
    normalizeTelemetryCode(row.motor_direction), row.movement ?? null, row.required_pulses ?? null,
    row.actual_pulses ?? null, row.final_position ?? null, row.battery_percent ?? null, row.battery_voltage ?? null,
  ]);
}

export function mergeWindRows(primaryRows, backupRows, timezone = 'Asia/Kolkata') {
  const primaryRowsBySlot = new Map();
  const primaryValidSlots = new Set();
  const addPrimary = (row) => {
    const timestamp = parseTimestamp(row.recorded_at);
    const slot = hourlySlotKey(row.recorded_at, timezone);
    if (!timestamp || !slot) return;
    if (!primaryRowsBySlot.has(slot)) primaryRowsBySlot.set(slot, []);
    primaryRowsBySlot.get(slot).push({ ...row, _timestamp: timestamp.getTime() });
    if (isValidWindReading(row)) primaryValidSlots.add(slot);
  };
  for (const row of primaryRows || []) addPrimary(row);

  const selected = [...primaryRowsBySlot.values()].flat();
  for (const row of backupRows || []) {
    const timestamp = parseTimestamp(row.recorded_at);
    const slot = hourlySlotKey(row.recorded_at, timezone);
    if (!timestamp || !slot) continue;
    // Keep operational events from both sources; only suppress backup compass readings
    // when a valid primary reading already covers that IST hour.
    if (isValidWindReading(row) && primaryValidSlots.has(slot)) continue;
    selected.push({ ...row, _timestamp: timestamp.getTime() });
  }

  const unique = new Map();
  for (const row of selected) {
    const key = windEventKey(row);
    if (!unique.has(key)) unique.set(key, row);
  }
  return [...unique.values()]
    .sort((a, b) => b._timestamp - a._timestamp || Number(b.id || 0) - Number(a.id || 0))
    .map((row) => {
      const result = { recorded_at: new Date(row._timestamp).toISOString() };
      for (const key of WIND_HISTORY_COLUMNS.slice(1)) result[key] = row[key] ?? null;
      return result;
    });
}

async function queryWindSource(env, table, baseParams) {
  const rows = [];
  let offset = 0;
  try {
    while (true) {
      const params = new URLSearchParams(baseParams);
      params.set('limit', String(WIND_PAGE_SIZE));
      params.set('offset', String(offset));
      const page = await querySupabase(env, table, params);
      if (!Array.isArray(page)) throw new Error(`Unexpected response from ${table}.`);
      rows.push(...page);
      if (page.length < WIND_PAGE_SIZE) return { rows, failed: false };
      offset += page.length;
    }
  } catch (error) {
    return { rows, failed: true };
  }
}

async function queryWindSources(env, params) {
  const [primary, backup] = await Promise.all([
    queryWindSource(env, 'wind_data', params),
    queryWindSource(env, 'wind_operation_logs', params),
  ]);
  const warnings = [];
  if (primary.failed) warnings.push('Primary wind_data could not be loaded completely.');
  if (backup.failed) warnings.push('Fallback wind_operation_logs could not be loaded completely.');
  return {
    rows: mergeWindRows(primary.rows, backup.rows, envValue(env, 'DASHBOARD_TIMEZONE') || 'Asia/Kolkata'),
    warnings,
  };
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
  const offlineMinutes = Number(envValue(env, 'OFFLINE_THRESHOLD_MINUTES') || '15');
  const now = new Date();
  const todayKey = localDateKey(now, timezone);
  const currentStartKey = shiftDateKey(todayKey, -(period - 1));
  const previousStartKey = shiftDateKey(currentStartKey, -period);
  const currentStart = localMidnight(currentStartKey, timezone);
  const previousStart = localMidnight(previousStartKey, timezone);
  const tomorrowStart = localMidnight(shiftDateKey(todayKey, 1), timezone);
  const supabaseUrl = envValue(env, 'SUPABASE_URL');

  try {
    const detectionParams = new URLSearchParams({
      select: DETECTION_COLUMNS,
      device_id: `eq.${deviceId}`,
      captured_at: `gte.${previousStart.toISOString()}`,
      order: 'captured_at.desc',
      limit: envValue(env, 'MAX_DETECTIONS') || '5000',
    });
    detectionParams.append('captured_at', `lt.${tomorrowStart.toISOString()}`);
    const rows = await querySupabase(env, 'detections', detectionParams);
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

    const telemetryParams = new URLSearchParams({
      select: TELEMETRY_COLUMNS,
      device_id: `eq.${deviceId}`,
      recorded_at: `gte.${currentStart.toISOString()}`,
      order: 'recorded_at.desc,id.desc',
    });
    telemetryParams.append('recorded_at', `lt.${tomorrowStart.toISOString()}`);
    const windSources = await queryWindSources(env, telemetryParams);
    const telemetryRows = windSources.rows;
    const latestEvent = telemetryRows[0] || null;
    const latestWind = telemetryRows.find(isValidWindReading) || null;
    const windPageRows = telemetryRows.slice(windOffset, windOffset + windLimit);
    const windHistory = windPageRows;
    const recordedAt = parseTimestamp(latestEvent?.recorded_at);
    const ageMinutes = recordedAt ? (now.getTime() - recordedAt.getTime()) / 60000 : null;
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
      kpis: {
        aphids_today: todayRows.reduce((sum, row) => sum + integerCount(row.insect_count), 0),
        images_today: todayRows.length,
        activity: activitySummary(currentRows, previousRows),
        last_detection: latest,
      },
      trend: Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count })),
      wind_history: windHistory,
      wind_history_warning: windSources.warnings.length ? windSources.warnings.join(' ') : null,
      wind_history_offset: windOffset,
      wind_history_limit: windLimit,
      wind_history_has_more: telemetryRows.length > windOffset + windLimit,
      latest_detection: latest,
      recent_detections: historyRows,
      history_offset: historyOffset,
      history_limit: historyLimit,
      history_has_more: historyOffset + historyLimit < currentRows.length,
      health: {
        available: Boolean(latestEvent),
        status: recordedAt && ageMinutes <= offlineMinutes ? 'online' : latestEvent ? 'offline' : 'unknown',
        last_communication: recordedAt?.toISOString() || null,
        fields,
      },
    });
  } catch (error) {
    return json({ detail: 'Unable to load monitoring data right now.' }, 502);
  }
}
