import { clearMetadataCache } from '../../functions/api/metadata-cache.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onRequestGet } from '../../functions/api/wind.js';
import { onRequestGet as dashboard } from '../../functions/api/dashboard.js';
const env = { SUPABASE_URL: 'https://legacy.invalid', SUPABASE_KEY: 'legacy-key', WIND_SUPABASE_URL: 'https://wind.invalid', WIND_SUPABASE_SECRET_KEY: 'wind-key', DASHBOARD_DEVICE_ID: 'PI5-001' };
const call = query => onRequestGet({ env, request: new Request('https://dashboard.invalid/api/wind?' + query) });
afterEach(() => { clearMetadataCache(); vi.unstubAllGlobals(); });
describe('wind operation API', () => {
  it('uses separate wind credentials and database filters with bounded pagination, preserving every outcome', async () => {
    const rows = [{ id: 1, device_id: 'PI5-002', status: 'FAILED', actual_pulses: 0 }, { id: 2, status: 'SUCCESS' }, { id: 3, status: 'DAILY_HOME' }];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(rows))));
    const response = await call('device_id=PI5-002&start_date=2026-11-01&end_date=2026-11-02&offset=2&limit=2');
    expect(response.status).toBe(200); const payload = await response.json();
    expect(payload.rows).toMatchObject(rows.slice(0, 2)); expect(payload.has_more).toBe(true);
    const [url, options] = fetch.mock.calls[0]; const parsed = new URL(url);
    expect(parsed.origin).toBe('https://wind.invalid'); expect(parsed.pathname).toBe('/rest/v1/wind_operation_logs');
    expect(options.headers.apikey).toBe('wind-key'); expect(parsed.searchParams.get('device_id')).toBe('eq.PI5-002');
    expect(parsed.searchParams.get('offset')).toBe('2'); expect(parsed.searchParams.get('limit')).toBe('3');
    expect(parsed.searchParams.getAll('recorded_at')).toEqual(['gte.2026-10-31T18:30:00.000Z', 'lt.2026-11-02T18:30:00.000Z']);
    expect(parsed.searchParams.has('status')).toBe(false);
  });
  it('derives unique devices from operation logs, never devices table', async () => {
    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(new URL(url).searchParams.get('select') === 'device_id' ? [{ device_id: 'B' }, { device_id: 'A' }, { device_id: 'B' }] : []))));
    const response = await call('include_devices=true'); expect((await response.json()).devices).toEqual(['A', 'B']);
    expect(fetch.mock.calls.every(([url]) => url.includes('/wind_operation_logs?'))).toBe(true);
  });
  it('returns clean errors for invalid dates and pagination without requests', async () => {
    vi.stubGlobal('fetch', vi.fn());
    for (const query of ['start_date=bad', 'start_date=2026-02-30', 'start_date=2026-11-03&end_date=2026-11-02', 'start_date=2020-01-01&end_date=2026-11-02', 'offset=-1', 'offset=2x', 'limit=51']) expect((await call(query)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not silently fall back to legacy credentials or data', async () => {
    expect((await onRequestGet({ env: {}, request: new Request('https://dashboard.invalid/api/wind') })).status).toBe(503);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private failure', { status: 500 })));
    const response = await call(''); expect(response.status).toBe(502); expect(JSON.stringify(await response.json())).not.toContain('private'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps detections in legacy project and wind in separate project', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
    const response = await dashboard({ env, request: new Request('https://dashboard.invalid/api/dashboard') }); expect(response.status).toBe(200);
    const urls = fetch.mock.calls.map(([url]) => new URL(url));
    expect(urls.filter(url => url.pathname.endsWith('/detections')).every(url => url.origin === 'https://legacy.invalid')).toBe(true);
    expect(urls.filter(url => url.pathname.endsWith('/wind_operation_logs')).every(url => url.origin === 'https://wind.invalid')).toBe(true);
    expect(urls.some(url => url.pathname.endsWith('/wind_data'))).toBe(false);
  });
});
