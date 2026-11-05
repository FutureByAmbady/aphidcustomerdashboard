// Sessions are a presentation of existing image records, never database rows.
export function indiaDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function groupImageSessions(records, { deviceId = 'all', startDate = '', endDate = '' } = {}) {
  const groups = new Map();
  for (const [index, image] of records.entries()) {
    if (deviceId !== 'all' && image.device_id !== deviceId) continue;
    const day = indiaDate(image.captured_at);
    if ((startDate || endDate) && (!day || (startDate && day < startDate) || (endDate && day > endDate))) continue;
    const explicit = image.session_id ?? image.capture_session_id;
    // Undated images without a session ID remain separate rather than implying a shared session.
    const key = JSON.stringify([image.device_id ?? null, explicit != null ? 'session' : 'day', explicit ?? (day || `undated-${image.id ?? index}`)]);
    if (!groups.has(key)) groups.set(key, { id: key, deviceId: image.device_id, sessionId: explicit, images: [], start: null, end: null });
    const group = groups.get(key);
    group.images.push(image);
    const timestamp = image.captured_at ? Date.parse(image.captured_at) : NaN;
    if (Number.isFinite(timestamp)) {
      group.start = group.start === null ? timestamp : Math.min(group.start, timestamp);
      group.end = group.end === null ? timestamp : Math.max(group.end, timestamp);
    }
  }
  return [...groups.values()].map(group => ({ ...group, images: group.images.sort((a, b) => (Date.parse(b.captured_at) || 0) - (Date.parse(a.captured_at) || 0)) }))
    .sort((a, b) => (b.start ?? -Infinity) - (a.start ?? -Infinity) || a.id.localeCompare(b.id));
}
