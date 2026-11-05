// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { cachedMetadata, clearMetadataCache } from '../../functions/api/metadata-cache.js';
import { onRequestGet } from '../../functions/api/images.js';
import { ImageFrame } from './ImagePreview.jsx';
const env = { IMAGE_SUPABASE_URL:'https://images.invalid', IMAGE_SUPABASE_SECRET_KEY:'test-key', DASHBOARD_DEVICE_ID:'PI5-001' };
afterEach(()=>{cleanup();clearMetadataCache();vi.unstubAllGlobals();vi.useRealTimers();});
it('coalesces identical concurrent metadata reads and expires the cache',async()=>{
  vi.useFakeTimers(); const loader=vi.fn(async()=>[{id:1}]);
  await Promise.all(Array.from({length:10},()=>cachedMetadata('same',loader)));
  expect(loader).toHaveBeenCalledTimes(1);
  await cachedMetadata('same',loader);expect(loader).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(60001);await cachedMetadata('same',loader);expect(loader).toHaveBeenCalledTimes(2);
});
it('uses database date/device filters, narrow columns and limit+1 pagination; repeats are cached',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify([{id:1,original_image_url:'https://images.invalid/storage/v1/object/public/monitoring-images/a.png'},{id:2},{id:3}]))));
  const request=new Request('https://dashboard.invalid/api/images?start_date=2026-11-01&end_date=2026-11-02&offset=4&limit=2');
  const response=await onRequestGet({env,request});const data=await response.json();expect(data.rows).toHaveLength(2);expect(data.has_more).toBe(true);
  expect(data.rows[0].thumbnail_url).toContain('/thumbnails/v1/a.jpg');
  const url=new URL(fetch.mock.calls[0][0]);expect(url.searchParams.get('select')).not.toContain('*');expect(url.searchParams.get('offset')).toBe('4');expect(url.searchParams.get('limit')).toBe('3');expect(url.searchParams.get('device_id')).toBe('eq.PI5-001');
  expect(url.searchParams.getAll('captured_at')).toEqual(['gte.2026-10-31T18:30:00.000Z','lt.2026-11-02T18:30:00.000Z']);
  await onRequestGet({env,request});expect(fetch).toHaveBeenCalledTimes(1);expect(response.headers.get('cache-control')).toContain('max-age=30');
});
it('rejects invalid pagination/date filters before querying',async()=>{
  vi.stubGlobal('fetch',vi.fn());
  for(const q of ['limit=51','offset=-1','start_date=2026-02-30'])expect((await onRequestGet({env,request:new Request('https://dashboard.invalid/api/images?'+q)})).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});
it('loads only small thumbnails and never falls back to an original on error',()=>{
  render(<ImageFrame detection={{original_image_url:'https://images.invalid/full.jpg',thumbnail_url:'https://images.invalid/small.jpg'}} />);
  const image=screen.getByRole('img');expect(image.src).toBe('https://images.invalid/small.jpg');expect(image.getAttribute('loading')).toBe('lazy');
  fireEvent.error(image);expect(screen.queryByRole('img')).toBeNull();expect(screen.getByText('Preview unavailable')).toBeTruthy();
});

it('tries the other small thumbnail once, without retry loops or original downloads',()=>{
  render(<ImageFrame detection={{result_image_url:'https://images.invalid/full.jpg',result_thumbnail_url:'https://images.invalid/result-small.jpg',thumbnail_url:'https://images.invalid/original-small.jpg'}} />);
  fireEvent.error(screen.getByRole('img'));expect(screen.getByRole('img').src).toContain('original-small.jpg');
  fireEvent.error(screen.getByRole('img'));expect(screen.queryByRole('img')).toBeNull();
});
it('does not cache errors and isolates metadata by credentials',async()=>{
  const loader=vi.fn().mockRejectedValueOnce(new Error('quota')).mockResolvedValueOnce([]);
  await expect(cachedMetadata('failed',loader)).rejects.toThrow('quota');
  await cachedMetadata('failed',loader);expect(loader).toHaveBeenCalledTimes(2);
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('[]')));
  const request=new Request('https://dashboard.invalid/api/images');
  await onRequestGet({env,request});await onRequestGet({env:{...env,IMAGE_SUPABASE_SECRET_KEY:'other-key'},request});expect(fetch).toHaveBeenCalledTimes(2);
});
