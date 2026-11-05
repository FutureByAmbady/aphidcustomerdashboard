const ACTION = 'register_new_sticky_sheet';
const UNAVAILABLE = 'Sticky sheet service is unavailable. Retry with the same request_id.';
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
const enabled = (env) => env.STICKY_SHEET_REPLACEMENT_ENABLED === 'true' && Boolean(env.STICKY_SHEET_REPLACEMENT_TOKEN?.trim());
export function validateBody(body, deviceId) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['device_id', 'request_id', 'requested_at', 'action', 'retry'].includes(k)) || body.device_id !== deviceId || body.action !== ACTION || typeof body.request_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.request_id) || typeof body.requested_at !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/i.test(body.requested_at) || !Number.isFinite(Date.parse(body.requested_at)) || Date.parse(body.requested_at) > Date.now() + 300000 || (body.retry !== undefined && typeof body.retry !== 'boolean')) throw new Error('Invalid sticky sheet request.');
  return { p_device_id: deviceId, p_request_id: body.request_id.toLowerCase(), p_requested_at: body.requested_at, p_retry: body.retry ?? false };
}
async function authorized(request, token) {
  const supplied = request.headers.get('Authorization') || '';
  const digest = text => crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const [a, b] = await Promise.all([digest(supplied), digest(`Bearer ${token}`)]);
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}
async function database(env, path, options = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY || env.SUPABASE_KEY;
  if (!key || !env.SUPABASE_URL) throw new Error('Unconfigured');
  const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${path}`, { ...options, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
  if (!response.ok) throw new Error('Database unavailable');
  return response.json();
}
export const onRequestOptions = () => new Response(null, { status: 204, headers });
export async function onRequestGet({ env }) {
  const device_id = env.DASHBOARD_DEVICE_ID || 'PI5-001';
  if (!enabled(env)) return json({ device_id, enabled: false, state: null, request: null });
  try {
    const stateParams = new URLSearchParams({ select: 'device_id,registered_at,completed_advances', device_id: `eq.${device_id}`, limit: '1' });
    const requestParams = new URLSearchParams({ select: 'request_id,device_id,action,requested_at,status,acknowledged_at,error_code', device_id: `eq.${device_id}`, order: 'created_at.desc', limit: '1' });
    const [states, requests] = await Promise.all([database(env, `sticky_sheet_state?${stateParams}`), database(env, `sticky_sheet_replacement_requests?${requestParams}`)]);
    if (!Array.isArray(states) || !Array.isArray(requests)) throw new Error('Invalid response');
    return json({ device_id, enabled: true, state: states[0] || null, request: requests[0] || null });
  } catch { return json({ detail: UNAVAILABLE }, 503); }
}
export async function onRequestPost({ request, env }) {
  if (!enabled(env)) return json({ detail: UNAVAILABLE }, 503);
  if (!await authorized(request, env.STICKY_SHEET_REPLACEMENT_TOKEN)) return json({ detail: 'Unauthorized' }, 401);
  let parameters;
  try { parameters = validateBody(await request.json(), env.DASHBOARD_DEVICE_ID || 'PI5-001'); }
  catch { return json({ detail: 'Invalid sticky sheet request.' }, 400); }
  try {
    const row = await database(env, 'rpc/register_sticky_sheet_replacement', { method: 'POST', body: JSON.stringify(parameters) });
    if (!row || !['pending', 'completed', 'failed'].includes(row.status)) throw new Error('Invalid response');
    return json({ request: row }, row.status === 'completed' ? 200 : 202);
  } catch { return json({ detail: UNAVAILABLE }, 503); }
}
