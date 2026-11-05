// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import WindHistory from './WindHistory.jsx';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('shows failed outcome alongside direction and full operation details, and filters only wind', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ rows: [{ id: 1, device_id: 'PI5-002', recorded_at: '2026-11-01T05:00:00Z', wind_direction: 'N', status: 'FAILED', target_position: 30, final_position: 0, required_pulses: 10, actual_pulses: 0, battery_percent: 80 }], devices: ['PI5-002'], has_more: true }))));
  render(<WindHistory apiBase="https://dashboard.invalid" />);
  await screen.findByText('FAILED'); expect(screen.getByText('Target: 30')).toBeTruthy(); expect(screen.getByText('Actual: 0')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Wind device'), { target: { value: 'PI5-002' } });
  fireEvent.click(screen.getByText('Apply'));
  await waitFor(() => expect(fetch.mock.calls.length).toBe(2));
  expect(fetch.mock.calls[1][0]).toContain('device_id=PI5-002');
  await waitFor(() => expect(screen.getByText('Next wind page').disabled).toBe(false));
  fireEvent.click(screen.getByText('Next wind page'));
  await waitFor(() => expect(fetch.mock.calls.length).toBe(3));
  expect(fetch.mock.calls[2][0]).toContain('offset=20');
  expect(fetch.mock.calls.every(([url]) => url.includes('/api/wind?'))).toBe(true);
});
