// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import WindHistory from './WindHistory.jsx';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('shows failed outcome alongside direction and customer-friendly columns, without device or date controls', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ rows: [{ id: 1, device_id: 'PI5-002', recorded_at: '2026-11-01T05:00:00Z', wind_direction: 'N', status: 'FAILED', target_position: 30, final_position: 0, required_pulses: 10, actual_pulses: 0, battery_percent: 80 }], devices: ['PI5-002'], has_more: true }))));
  render(<WindHistory apiBase="https://dashboard.invalid" />);
  await screen.findByText('FAILED'); expect(screen.queryByText('Target: 30')).toBeNull(); expect(screen.queryByText('Actual: 0')).toBeNull();
  expect(screen.getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Time / device', 'Wind', 'Battery', 'Outcome']);
  expect(screen.getByText('80%')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Wind history' })).toBeTruthy();
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByLabelText('Wind start date')).toBeNull();
  expect(screen.queryByText('Apply')).toBeNull();
  expect(new URL(fetch.mock.calls[0][0]).searchParams.has('include_devices')).toBe(false);
  await waitFor(() => expect(screen.getByText('Read more').disabled).toBe(false));
  fireEvent.click(screen.getByText('Read more'));
  await waitFor(() => expect(fetch.mock.calls.length).toBe(2));
  expect(fetch.mock.calls[1][0]).toContain('offset=5');
  expect(fetch.mock.calls.every(([url]) => url.includes('/api/wind?'))).toBe(true);
});
it('loads five readings initially and appends five only after Read more', async () => {
  vi.stubGlobal('fetch', vi.fn(async url => {
    const offset = Number(new URL(url).searchParams.get('offset'));
    return new Response(JSON.stringify({ rows: Array.from({ length: 5 }, (_, i) => ({ id: offset + i, status: `OUTCOME_${offset+i}`, device_id: 'PI5-001' })), has_more: offset === 0 }));
  }));
  render(<WindHistory apiBase="https://dashboard.invalid" />);
  await screen.findByText('OUTCOME_4');
  expect(screen.getAllByRole('row')).toHaveLength(6);
  expect(new URL(fetch.mock.calls[0][0]).searchParams.get('limit')).toBe('5');
  expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText('Read more'));
  await screen.findByText('OUTCOME_9');
  expect(screen.getAllByRole('row')).toHaveLength(11);
  expect(screen.getByText('OUTCOME_0')).toBeTruthy();
  expect(screen.queryByText('Read more')).toBeNull();
  expect(new URL(fetch.mock.calls[1][0]).searchParams.get('offset')).toBe('5');
});
