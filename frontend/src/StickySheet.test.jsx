// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import StickySheet from './StickySheet.jsx';
import { usage } from './stickySheet.js';
const id = '00000000-0000-4000-8000-000000000001';
const row = { device_id: 'PI5-001', request_id: id, requested_at: '2026-10-31T00:00:00Z', action: 'register_new_sticky_sheet', status: 'pending', acknowledged_at: null };
let snapshot, posts;
const response = body => ({ ok: true, status: 200, json: async () => body });
beforeEach(() => {
  sessionStorage.clear(); posts = [];
  snapshot = { device_id: 'PI5-001', enabled: true, state: null, request: null };
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    if (options?.method === 'POST') { posts.push(JSON.parse(options.body)); snapshot = { ...snapshot, request: row }; return response({ request: row }); }
    return response(snapshot);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function mount() { render(<StickySheet deviceId="PI5-001" apiBase="" timezone="Asia/Kolkata" />); await waitFor(() => expect(screen.getByRole('button', { name: 'Replace Sticky Sheet' }).disabled).toBe(false)); }
function confirm() { fireEvent.click(screen.getByRole('checkbox')); }
function next() { confirm(); fireEvent.click(screen.getByRole('button', { name: 'Continue' })); }
async function openFinal() { fireEvent.click(screen.getByRole('button', { name: /Replace Sticky Sheet|Retry Replacement Request/ })); next(); next(); confirm(); fireEvent.change(screen.getByLabelText(/Replacement authorization key/), { target: { value: 'test-key' } }); }
describe('replacement wizard', () => {
  for (const step of [0, 1, 2]) it(`cancel step ${step + 1} never submits`, async () => {
    await mount(); fireEvent.click(screen.getByRole('button', { name: 'Replace Sticky Sheet' }));
    for (let i = 0; i < step; i++) next();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(posts).toHaveLength(0); expect(sessionStorage.length).toBe(0);
  });
  it('requires a fresh explicit checkbox at every step and authorization at final step', async () => {
    await mount(); fireEvent.click(screen.getByRole('button', { name: 'Replace Sticky Sheet' }));
    expect(screen.getByRole('button', { name: 'Continue' }).disabled).toBe(true); next();
    expect(screen.getByRole('checkbox').checked).toBe(false); next();
    expect(screen.getByRole('button', { name: 'Register Replacement' }).disabled).toBe(true);
    confirm(); expect(screen.getByRole('button', { name: 'Register Replacement' }).disabled).toBe(true); expect(posts).toHaveLength(0);
  });
  it('submits once and remains pending for an offline device', async () => {
    await mount(); await openFinal(); const button = screen.getByRole('button', { name: 'Register Replacement' });
    fireEvent.click(button); fireEvent.click(button);
    await screen.findByText('Replacement Pending – Waiting for Device');
    expect(posts).toHaveLength(1); expect(posts[0].action).toBe('register_new_sticky_sheet');
    expect(screen.queryByText('New Sticky Sheet Registered Successfully')).toBeNull();
    expect(screen.getByRole('button', { name: 'Replace Sticky Sheet' }).disabled).toBe(true);
  });
  it('retains the same request ID after a lost submission response', async () => {
    let failed;
    fetch.mockImplementation(async (_url, options) => { if (options?.method === 'POST') { const p = JSON.parse(options.body); if (!failed) { failed = p; throw new Error('Network unavailable'); } posts.push(p); snapshot.request = { ...row, request_id: p.request_id }; return response({ request: snapshot.request }); } return response(snapshot); });
    await mount(); await openFinal(); fireEvent.click(screen.getByRole('button', { name: 'Register Replacement' }));
    await screen.findAllByText('Network unavailable');
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText(/Replacement authorization key/), { target: { value: 'test-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry Same Request' }));
    await waitFor(() => expect(posts).toHaveLength(1)); expect(posts[0].request_id).toBe(failed.request_id);
  });
  it('displays failure without reset and retries the existing ID', async () => {
    snapshot.request = { ...row, status: 'failed' }; snapshot.state = { registered_at: '2026-10-01T00:00:00Z', completed_advances: 8 };
    render(<StickySheet deviceId="PI5-001" apiBase="" />); await screen.findByText('Replacement Pending – Processing Failed');
    await openFinal(); fireEvent.click(screen.getByRole('button', { name: 'Retry Same Request' }));
    await waitFor(() => expect(posts).toHaveLength(1)); expect(posts[0].request_id).toBe(id); expect(posts[0].retry).toBe(true); expect(screen.getByText('8')).toBeTruthy();
  });
  it('only reports success with a backend acknowledgement timestamp', async () => {
    snapshot.request = { ...row, status: 'completed', acknowledged_at: '2026-10-31T02:00:00Z' };
    snapshot.state = { registered_at: new Date().toISOString(), completed_advances: 0 };
    await mount(); await screen.findByText('New Sticky Sheet Registered Successfully'); expect(screen.getAllByText('0 days')).toHaveLength(1); expect(screen.getByText('90 days')).toBeTruthy();
  });
  it('does not invent an initial usage baseline', () => { expect(usage(null)).toEqual({ days: null, remaining: null }); expect(usage({ registered_at: '2026-01-01T00:00:00Z' }, Date.parse('2026-04-11T00:00:00Z'))).toEqual({ days: 100, remaining: 0 }); });
  it('disabled configuration cannot submit', async () => {
    snapshot.enabled = false; render(<StickySheet deviceId="PI5-001" apiBase="" />);
    await screen.findByText('Status unavailable – replacement registration not enabled'); expect(screen.getByRole('button', { name: 'Replace Sticky Sheet' }).disabled).toBe(true); expect(posts).toHaveLength(0);
  });
});
