import { windBounds, windPage, windDevices } from './dashboard.js';
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...(status === 200 ? { 'Cache-Control': 'public, max-age=60, s-maxage=300' } : {}) } });
export async function onRequestGet({ request, env }) {
  const params = new URL(request.url).searchParams;
  const offsetText = params.get('offset') ?? '0';
  const limitText = params.get('limit') ?? '20';
  const offset = Number(offsetText), limit = Number(limitText);
  const deviceId = (params.get('device_id') || '').trim();
  if (!/^\d+$/.test(offsetText) || !/^\d+$/.test(limitText) || !Number.isSafeInteger(offset) || offset > 1000000 || limit < 1 || limit > 50 || deviceId.length > 128) return json({ detail: 'Invalid wind pagination or device filter.' }, 400);
  let start, end;
  try { [start, end] = windBounds(params.get('start_date'), params.get('end_date'), env.DASHBOARD_TIMEZONE || 'Asia/Kolkata'); }
  catch (error) { return json({ detail: error.message }, 400); }
  if (!env.WIND_SUPABASE_URL || !env.WIND_SUPABASE_SECRET_KEY) return json({ detail: 'Wind operation logs are not configured on this server.' }, 503);
  try {
    const result = await windPage(env, deviceId, start, end, offset, limit, params.get('customer_view') === 'true');
    if (params.get('include_devices') === 'true') {
      try { result.devices = await windDevices(env); }
      catch { result.devices = []; result.warning = 'Device options could not be loaded. Operation records are still shown.'; }
    }
    return json(result);
  } catch { return json({ detail: 'Unable to load wind operation logs right now.' }, 502); }
}

export { onRequestOptions } from './dashboard.js';
