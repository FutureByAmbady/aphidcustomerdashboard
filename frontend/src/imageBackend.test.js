import { afterEach, describe, expect, it, vi } from 'vitest';
import { onRequestGet } from '../../functions/api/dashboard.js';
const legacy = { SUPABASE_URL: 'https://legacy.invalid', SUPABASE_SERVICE_ROLE_KEY: 'legacy-key', SUPABASE_BUCKET: 'monitoring-images', DASHBOARD_DEVICE_ID: 'PI5-001', WIND_SUPABASE_URL: 'https://wind.invalid', WIND_SUPABASE_SECRET_KEY: 'wind-key' };
const dedicated = { ...legacy, IMAGE_SUPABASE_URL: 'https://images.invalid', IMAGE_SUPABASE_SECRET_KEY: 'images-key' };
const call = env => onRequestGet({ env, request: new Request('https://dashboard.invalid/api/dashboard') });
afterEach(() => vi.unstubAllGlobals());
describe('dedicated image project', () => {
  it('uses IMAGE credentials for detections and image paths while leaving wind unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(String(url).includes('/detections?') ? [{ device_id: 'PI5-001', captured_at: new Date().toISOString(), insect_count: 2, result_image_url: 'device/result image.jpg', original_image_url: 'https://existing.invalid/original.jpg' }] : []))));
    const response = await call(dedicated); expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.latest_detection.result_image_url).toBe('https://images.invalid/storage/v1/object/public/monitoring-images/device/result%20image.jpg');
    expect(payload.latest_detection.original_image_url).toBe('https://existing.invalid/original.jpg');
    for (const [url, options] of fetch.mock.calls) {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/detections')) { expect(parsed.origin).toBe('https://images.invalid'); expect(options.headers.apikey).toBe('images-key'); expect(parsed.searchParams.get('device_id')).toBe('eq.PI5-001'); }
      else { expect(parsed.origin).toBe('https://wind.invalid'); expect(options.headers.apikey).toBe('wind-key'); }
    }
    expect(fetch.mock.calls.some(([url]) => url.startsWith('https://legacy.invalid'))).toBe(false);
  });
  it('falls back to legacy only when IMAGE config is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
    expect((await call(legacy)).status).toBe(200);
    const detection = fetch.mock.calls.find(([url]) => url.includes('/detections?'));
    expect(detection[0]).toContain('https://legacy.invalid'); expect(detection[1].headers.apikey).toBe('legacy-key');
  });
  it('returns genuine empty arrays and null latest detection for an empty new project', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
    const payload = await (await call(dedicated)).json();
    expect(payload.recent_detections).toEqual([]); expect(payload.trend).toEqual([]); expect(payload.latest_detection).toBeNull(); expect(payload.kpis.activity.label).toBe('Not enough data');
  });
  it('never mixes partial image configuration with legacy keys, and still loads wind', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
    for (const env of [{ ...legacy, IMAGE_SUPABASE_URL: 'https://images.invalid' }, { ...legacy, IMAGE_SUPABASE_SECRET_KEY: 'images-key' }]) {
      const response = await call(env); expect(response.status).toBe(200); expect((await response.json()).image_warning).toContain('unavailable');
    }
    expect(fetch.mock.calls.every(([url]) => String(url).includes('https://wind.invalid'))).toBe(true);
  });
  it('does not fall back after an IMAGE project query failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async url => String(url).includes('/detections?') ? new Response('private quota error', { status: 402 }) : new Response('[]')));
    const response = await call(dedicated); expect(response.status).toBe(200);
    const payload = await response.json(); expect(payload.image_warning).toContain('402'); expect(JSON.stringify(payload)).not.toContain('private');
    const imageCalls = fetch.mock.calls.filter(([url]) => String(url).includes('/detections?'));
    expect(imageCalls).toHaveLength(1); expect(imageCalls[0][0]).toContain('https://images.invalid');
  });
});
