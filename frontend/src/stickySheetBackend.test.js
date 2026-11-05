import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { onRequestGet, onRequestPost } from '../../functions/api/sticky-sheet.js';
const env = { STICKY_SHEET_REPLACEMENT_ENABLED: 'true', STICKY_SHEET_REPLACEMENT_TOKEN: 'private-test-key', DASHBOARD_DEVICE_ID: 'PI5-001', SUPABASE_URL: 'https://test.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test-only' };
const payload = { device_id: 'PI5-001', request_id: '00000000-0000-4000-8000-000000000001', requested_at: '2026-10-31T00:00:00Z', action: 'register_new_sticky_sheet' };
const post = (body = payload, token = env.STICKY_SHEET_REPLACEMENT_TOKEN) => onRequestPost({ env, request: new Request('https://dashboard.invalid/api/sticky-sheet', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }) });
afterEach(() => vi.unstubAllGlobals());
describe('Cloudflare adapter', () => {
  it('disabled GET never touches database', async () => { vi.stubGlobal('fetch', vi.fn()); const r = await onRequestGet({ env: {} }); expect((await r.json()).enabled).toBe(false); expect(fetch).not.toHaveBeenCalled(); });
  it('rejects missing authorization before database', async () => { vi.stubGlobal('fetch', vi.fn()); expect((await post(payload, 'wrong')).status).toBe(401); expect(fetch).not.toHaveBeenCalled(); });
  it('rejects wrong device/action/id', async () => { for (const changes of [{ device_id: 'other' }, { action: 'capture' }, { request_id: 'bad' }]) expect((await post({ ...payload, ...changes })).status).toBe(400); });
  it('submission returns pending, not completed, and uses only the registration RPC', async () => { vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...payload, status: 'pending' })))); const r = await post(); expect(r.status).toBe(202); expect((await r.json()).request.status).toBe('pending'); expect(fetch.mock.calls[0][0]).toBe('https://test.invalid/rest/v1/rpc/register_sticky_sheet_replacement'); });
  it('database failure is generic and retry retains caller ID', async () => { vi.stubGlobal('fetch', vi.fn(async () => new Response('secret failure', { status: 500 }))); const r = await post({ ...payload, retry: true }); expect(r.status).toBe(503); expect(JSON.stringify(await r.json())).not.toContain('secret'); expect(JSON.parse(fetch.mock.calls[0][1].body).p_request_id).toBe(payload.request_id); });
});
describe('staged PostgreSQL migration', () => {
  let db;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec("create role anon; create role authenticated; create role service_role; create table devices(device_id text); insert into devices values ('PI5-001'); create table wind_history(id int); insert into wind_history values (1);");
    await db.exec(readFileSync(new URL('../../migrations/20261031_sticky_sheet.sql', import.meta.url), 'utf8'));
  }, 30000);
  const register = (id = payload.request_id, retry = false) => db.query('select register_sticky_sheet_replacement($1,$2,now(),$3) as r', ['PI5-001', id, retry]).then(r => r.rows[0].r);
  const ack = success => db.query('select acknowledge_sticky_sheet_replacement($1,$2,$3) as r', ['PI5-001', payload.request_id, success]).then(r => r.rows[0].r);
  it('duplicate requests share one pending row; offline leaves state untouched', async () => {
    const first = await register(); expect(first.status).toBe('pending');
    expect((await register()).request_id).toBe(first.request_id);
    expect((await register('00000000-0000-4000-8000-000000000002')).request_id).toBe(first.request_id);
    expect((await db.query('select * from sticky_sheet_state')).rows).toHaveLength(0);
    expect((await db.query('select * from sticky_sheet_replacement_requests')).rows).toHaveLength(1);
  });
  it('failure does not reset usage; same ID retries', async () => { expect((await ack(false)).status).toBe('failed'); expect((await db.query('select * from sticky_sheet_state')).rows).toHaveLength(0); expect((await register(payload.request_id, true)).status).toBe('pending'); });
  it('successful acknowledgement resets once; replay does not reset again or affect history', async () => {
    const done = await ack(true); expect(done.status).toBe('completed'); expect(done.acknowledged_at).toBeTruthy();
    expect((await db.query('select completed_advances from sticky_sheet_state')).rows[0].completed_advances).toBe(0);
    await db.exec('update sticky_sheet_state set completed_advances=3');
    await ack(true); await register(payload.request_id, true);
    expect((await db.query('select completed_advances from sticky_sheet_state')).rows[0].completed_advances).toBe(3);
    expect((await db.query('select * from wind_history')).rows).toEqual([{ id: 1 }]);
  });
  it('anonymous clients cannot execute registration or acknowledgement', async () => { expect((await db.query("select has_function_privilege('anon','public.register_sticky_sheet_replacement(text,uuid,timestamptz,boolean)','execute') as allowed")).rows[0].allowed).toBe(false); expect((await db.query("select has_function_privilege('authenticated','public.acknowledge_sticky_sheet_replacement(text,uuid,boolean)','execute') as allowed")).rows[0].allowed).toBe(false); });
});
