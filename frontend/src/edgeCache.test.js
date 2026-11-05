import { afterEach, expect, it, vi } from 'vitest';
import { onRequest } from '../../functions/api/_middleware.js';
afterEach(()=>vi.unstubAllGlobals());
it('shares successful public metadata across requests without calling upstream again',async()=>{
  const saved=new Map();vi.stubGlobal('caches',{default:{match:async key=>saved.get(key.url)?.clone(),put:async(key,value)=>{saved.set(key.url,value);}}});
  const next=vi.fn(async()=>new Response('{}',{headers:{'Cache-Control':'public, max-age=60, s-maxage=300'}}));
  await onRequest({request:new Request('https://dashboard.invalid/api/wind?limit=5&offset=0'),next});
  await onRequest({request:new Request('https://dashboard.invalid/api/wind?offset=0&limit=5'),next});
  expect(next).toHaveBeenCalledTimes(1);
});
it('never caches mutations, sticky sheet state, authenticated requests, or errors',async()=>{
  const cache={match:vi.fn(),put:vi.fn()};vi.stubGlobal('caches',{default:cache});
  const next=vi.fn(async()=>new Response('{}',{status:503}));
  for (const request of [new Request('https://dashboard.invalid/api/sticky-sheet'),new Request('https://dashboard.invalid/api/sticky-sheet',{method:'POST'}),new Request('https://dashboard.invalid/api/wind',{headers:{Authorization:'Bearer test'}}),new Request('https://dashboard.invalid/api/wind',{headers:{Cookie:'session=test'}})]) await onRequest({request,next});
  expect(cache.match).not.toHaveBeenCalled();
  await onRequest({request:new Request('https://dashboard.invalid/api/images'),next});
  expect(cache.put).not.toHaveBeenCalled();
});
it('continues when the edge cache is unavailable',async()=>{
  vi.stubGlobal('caches',{default:{match:async()=>{throw new Error('cache unavailable');}}});
  const next=vi.fn(async()=>new Response('{}',{status:503}));
  expect((await onRequest({request:new Request('https://dashboard.invalid/api/wind'),next})).status).toBe(503);
});
