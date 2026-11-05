import { useMemo, useState } from 'react';
import { groupImageSessions } from './imageSessions.js';
import { ImageFrame, ImageLinks } from './ImagePreview.jsx';

export default function ImageSessions({ rows, timezone = 'Asia/Kolkata', warning, truncated, period }) {
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const sessions = useMemo(() => groupImageSessions(rows, { startDate, endDate }), [rows, startDate, endDate]);
  const selected = sessions.find(session => session.id === selectedId);
  const time = value => value == null ? 'Timestamp unavailable' : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(value));
  return <section className="panel image-sessions-panel" aria-label="Image Sessions">
    <div className="panel-heading"><div><p className="eyebrow">Captured images</p><h3>Image Sessions</h3></div></div>
    <p className="muted">Existing records grouped by session identifier, or device and capture day (IST). Showing the selected {period}-day monitoring period; change the period above to load more dates.</p>
    <div className="wind-filters">
      <label>From<input aria-label="Image sessions from date" type="date" value={startDate} max={endDate || undefined} onChange={event => { setStartDate(event.target.value); setSelectedId(null); }} /></label>
      <label>To<input aria-label="Image sessions to date" type="date" value={endDate} min={startDate || undefined} onChange={event => { setEndDate(event.target.value); setSelectedId(null); }} /></label>
    </div>
    {warning ? <div className="empty-state">Image sessions unavailable. {warning}</div> : selected ? <>
      <div className="panel-heading"><button className="secondary-button" onClick={() => setSelectedId(null)}>All sessions</button><span>{selected.deviceId} · {selected.images.length} images · {time(selected.start)}</span></div>
      <div className="session-image-grid">{selected.images.map((image, index) => <article className="session-image-card" key={image.id ?? index}>
        <ImageFrame detection={image} />
        <p>{time(image.captured_at)}</p>
        <p>{image.insect_count == null ? 'Detection count unavailable' : `${image.insect_count} aphids`}{image.average_confidence == null ? '' : ` · Confidence ${Math.round(image.average_confidence * 100)}%`}</p>
        <ImageLinks detection={image} compact />
      </article>)}</div>
    </> : sessions.length ? <div className="session-image-grid">{sessions.map(session => <button className="session-image-card session-open" key={session.id} onClick={() => setSelectedId(session.id)}>
      <ImageFrame detection={session.images[0]} />
      <strong>{session.deviceId} · {session.images.length} images</strong><span>{time(session.start)} — {time(session.end)}</span><span>Open session</span>
    </button>)}</div> : <div className="empty-state">No captured image sessions for these filters.</div>}
    {truncated && <p role="status" className="muted">The server record limit was reached. Counts and sessions may be incomplete; select a shorter monitoring period.</p>}
  </section>;
}
