import { imagePage, onRequestOptions } from './dashboard.js';
export { onRequestOptions };
export async function onRequestGet({ request, env }) {
  const p = new URL(request.url).searchParams;
  const offset = p.get('offset') ?? '0', limit = p.get('limit') ?? '20';
  const period = Number(p.get('period') || '7');
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
    'Cache-Control': status === 200 ? 'public, max-age=60, s-maxage=300' : 'no-store' } });
  if (!/^\d+$/.test(offset) || !/^\d+$/.test(limit) || !Number.isSafeInteger(Number(offset)) || Number(offset) > 1000000 || Number(limit) < 1 || Number(limit) > 50 || !Number.isInteger(period) || period < 1 || period > 30) return json({ detail: 'Invalid image pagination.' }, 400);
  try { return json(await imagePage(env, { period, start_date: p.get('start_date'), end_date: p.get('end_date'), offset: Number(offset), limit: Number(limit) })); }
  catch (error) { return json({ detail: error.status === 402 ? 'Image history is restricted by the source database egress quota (HTTP 402).' : error.message?.startsWith('Wind date range') ? 'Image date range must be valid, ordered, and no longer than 366 days.' : 'Image history is temporarily unavailable.' }, error.message?.startsWith('Wind date range') ? 400 : 503); }
}
