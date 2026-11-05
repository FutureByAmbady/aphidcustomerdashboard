// Isolate-local cache only: bounded, credential-scoped, and never used for writes.
// Cloudflare can start another isolate; a miss must always remain correct.
const entries = new Map();
const pending = new Map();
const TTL_MS = 60000;
export function clearMetadataCache() { entries.clear(); pending.clear(); }
export async function cachedMetadata(key, loader, ttl = TTL_MS) {
  const hit = entries.get(key);
  if (hit && hit.expires > Date.now()) return structuredClone(hit.value);
  if (pending.has(key)) return structuredClone(await pending.get(key));
  const request = (async () => {
    const value = await loader();
    if (entries.size >= 128) entries.delete(entries.keys().next().value);
    entries.set(key, { value: structuredClone(value), expires: Date.now() + ttl });
    return value;
  })();
  pending.set(key, request);
  try { return structuredClone(await request); }
  finally { pending.delete(key); }
}
