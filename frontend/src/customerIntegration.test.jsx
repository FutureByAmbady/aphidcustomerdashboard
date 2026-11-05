// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { onRequestGet } from '../../functions/api/dashboard.js';
import WindHistory from './WindHistory.jsx';
import ImageSessions from './ImageSessions.jsx';
import { groupImageSessions } from './imageSessions.js';
const env = { IMAGE_SUPABASE_URL: 'https://images.invalid', IMAGE_SUPABASE_SECRET_KEY: 'sb_secret_images', WIND_SUPABASE_URL: 'https://wind.invalid', WIND_SUPABASE_SECRET_KEY: 'sb_secret_wind' };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('uses modern keys only as apikey and never derives connectivity from operations', async () => {
  vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(String(url).includes('/detections?') ? [] : [{ id: 1, device_id: 'PI5-001', recorded_at: new Date().toISOString(), status: 'SUCCESS' }]))));
  const payload = await (await onRequestGet({ env, request: new Request('https://dashboard.invalid/api/dashboard') })).json();
  expect(payload.health.status).toBe('unknown'); expect(payload.health.last_communication).toBeNull(); expect(payload.health.last_operation).toBeTruthy();
  for (const [, options] of fetch.mock.calls) { expect(options.headers.apikey).toMatch(/^sb_secret_/); expect(options.headers.Authorization).toBeUndefined(); }
});
it('isolates HTTP 402 images while returning real wind records without zero image statistics', async () => {
  vi.stubGlobal('fetch', vi.fn(async url => String(url).includes('/detections?') ? new Response('{}', { status: 402 }) : new Response(JSON.stringify([{ id: 1, status: 'MOVEMENT_FAILED' }]))));
  const response = await onRequestGet({ env, request: new Request('https://dashboard.invalid/api/dashboard') });
  expect(response.status).toBe(200); const payload = await response.json();
  expect(payload.image_warning).toContain('402'); expect(payload.kpis.images_today).toBeNull(); expect(payload.wind_history[0].status).toBe('MOVEMENT_FAILED');
});
it('renders all required outcomes, zero readings and India time, with date/device filters and pagination', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ rows: ['SUCCESS', 'MOVEMENT_FAILED', 'SENSOR_NO_DATA'].map((status,id) => ({ id, device_id:'PI5-001', recorded_at: '2026-11-01T20:00:00Z', status, actual_pulses:0, target_position:90, final_position:0, battery_voltage:12.5, battery_percent:50 })), devices:['PI5-001'], has_more:true }))));
  render(<WindHistory apiBase="https://dashboard.invalid" />); await screen.findByText('SENSOR_NO_DATA');
  expect(screen.getByText('MOVEMENT_FAILED')).toBeTruthy(); expect(screen.getByText('SUCCESS')).toBeTruthy();
  expect(screen.getAllByText(/2 Nov 2026, 1:30 am/i).length).toBe(3); expect(screen.getAllByText('Actual: 0').length).toBe(3);
  fireEvent.change(screen.getByLabelText('Wind start date'),{target:{value:'2026-11-01'}});fireEvent.change(screen.getByLabelText('Wind end date'),{target:{value:'2026-11-02'}});fireEvent.change(screen.getByLabelText('Wind device'),{target:{value:'PI5-001'}});fireEvent.click(screen.getByText('Apply'));
  await waitFor(()=>expect(fetch.mock.calls.length).toBe(2));expect(fetch.mock.calls[1][0]).toContain('start_date=2026-11-01');expect(fetch.mock.calls[1][0]).toContain('device_id=PI5-001');
  await waitFor(()=>expect(screen.getByText('Next wind page').disabled).toBe(false));fireEvent.click(screen.getByText('Next wind page'));await waitFor(()=>expect(fetch.mock.calls[2][0]).toContain('offset=20'));
});
it('groups sessions by explicit IDs or IST capture day, opens previews and date filters', () => {
  const rows=[{ id:1, device_id:'PI5-001', captured_at:'2026-11-01T20:00:00Z', insect_count:2, original_image_url:'https://images.invalid/a.jpg' },{ id:2,device_id:'PI5-001',captured_at:'2026-11-02T02:00:00Z',insect_count:0 }];
  expect(groupImageSessions(rows)).toHaveLength(1);
  expect(groupImageSessions(rows.map((row,i)=>({...row,session_id:String(i)})))).toHaveLength(2);
  render(<ImageSessions rows={rows} period={7} />);fireEvent.click(screen.getByText('Open session'));expect(screen.getByText('2 aphids')).toBeTruthy();expect(screen.getByAltText('Original image').getAttribute('src')).toBe('https://images.invalid/a.jpg');
  fireEvent.change(screen.getByLabelText('Image sessions from date'),{target:{value:'2026-11-03'}});expect(screen.getByText('No captured image sessions for these filters.')).toBeTruthy();
});
