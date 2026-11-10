// Public read-only metadata only. Never cache writes, credentials, or sticky-sheet state.
const READ_PATHS = new Set(['/api/dashboard', '/api/images', '/api/wind']);
export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  if (request.method !== 'GET' || !READ_PATHS.has(url.pathname) || request.headers.has('Authorization') || request.headers.has('Cookie')) return context.next();
  const cache = globalThis.caches?.default;
  if (!cache) return context.next();
  // Isolate old cached snapshots from the corrected live wind-table source.
  if (url.pathname === '/api/wind' || url.pathname === '/api/dashboard') url.searchParams.set('_source_version', 'wind_recorded_fallback_v1');
  url.searchParams.sort();
  const key = new Request(url.toString(), { method: 'GET' });
  try {
    const hit = await cache.match(key);
    if (hit) return hit;
  } catch { /* Cache failures must not prevent real reads. */ }
  const response = await context.next();
  if (response.status === 200 && response.headers.get('Cache-Control')?.includes('public') && !response.headers.has('Set-Cookie')) {
    const save = cache.put(key, response.clone()).catch(() => {});
    if (context.waitUntil) context.waitUntil(save);
    else await save;
  }
  return response;
}
