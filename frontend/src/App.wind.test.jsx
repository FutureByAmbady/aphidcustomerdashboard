// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import App from './App.jsx';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('shows real wind history even when legacy monitoring fails from quota exhaustion', async () => {
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (String(url).includes('/api/wind?')) return new Response(JSON.stringify({ rows: [{ id: 9, device_id: 'PI5-001', recorded_at: '2026-11-05T02:00:00Z', status: 'FAILED', actual_pulses: 0 }], devices: ['PI5-001'], has_more: false }));
    return new Response(JSON.stringify({ detail: 'Unable to load monitoring data right now.' }), { status: 502 });
  }));
  render(<App />);
  await screen.findByText('Unable to load monitoring data right now.');
  await screen.findByText('FAILED');
  expect(screen.getByText('Actual: 0')).toBeTruthy();
  expect(screen.queryByText('Aphids detected today')).toBeNull();
  expect(fetch.mock.calls.some(([url]) => String(url).includes('/api/wind?'))).toBe(true);
});
