// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from './App.jsx';
vi.mock('./StickySheet.jsx', () => ({ default: () => null }));
vi.mock('./WindHistory.jsx', () => ({ default: () => null }));
const row = id => ({id, captured_at:'2026-11-05T02:00:00Z', insect_count:id, device_id:'PI5-001'});
const payload = {recent_detections:Array.from({length:5},(_,i)=>row(i)), image_records:[], history_has_more:true, kpis:{activity:{percentage:null}}, timezone:'Asia/Kolkata'};
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();});
it('advances by server rows, not deduplicated rendered count, and shows page errors',async()=>{
  vi.stubGlobal('fetch',vi.fn(async url=>new Response(JSON.stringify(String(url).includes('/api/dashboard') ? payload : String(url).includes('offset=5&') ? {rows:Array.from({length:20},(_,i)=>row(i+4)),offset:5,has_more:true} : {detail:'Image history unavailable'}), {status:String(url).includes('offset=25&')?503:200})));
  render(<App/>); await screen.findByText('Show more');
  fireEvent.click(screen.getByText('Show more')); await screen.findByText('19');
  fireEvent.click(screen.getByText('Show more')); await screen.findByRole('alert');
  expect(fetch.mock.calls[2][0]).toContain('offset=25&');
  expect(screen.getByRole('alert').textContent).toContain('Image history unavailable');
});
it('refreshes after five minutes, never at fifteen seconds, and skips hidden tabs',async()=>{
  vi.useFakeTimers();
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(payload))));
  await act(async()=>{render(<App/>);});
  await act(async()=>{await vi.advanceTimersByTimeAsync(15000);}); expect(fetch).toHaveBeenCalledTimes(1);
  await act(async()=>{await vi.advanceTimersByTimeAsync(285000);}); expect(fetch).toHaveBeenCalledTimes(2);
  const hidden = vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');
  await act(async()=>{await vi.advanceTimersByTimeAsync(300000);}); expect(fetch).toHaveBeenCalledTimes(2); hidden.mockRestore();
});
