import { useCallback, useEffect, useRef, useState } from 'react';
import { QUESTIONS, advanceStep, canSubmit, confirmedSuccess, newRequest, requestFromRow, sheetStatus, usage } from './stickySheet.js';

export default function StickySheet({ deviceId, apiBase, timezone }) {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [token, setToken] = useState('');
  const [draft, setDraft] = useState(null);
  const dialog = useRef(null);
  const trigger = useRef(null);
  const submitting = useRef(false);
  const storageKey = `sticky-sheet-request:${deviceId}`;
  const refresh = useCallback(async (signal) => {
    try {
      const response = await fetch(`${apiBase}/api/sticky-sheet`, { signal });
      const body = await response.json();
      if (!response.ok || body.device_id !== deviceId) throw new Error('Unable to check sticky sheet status. No completion has been confirmed.');
      setSnapshot(body);
      setError('');
      if (body.request && ['pending', 'completed'].includes(body.request.status)) {
        setDraft(null);
        try { sessionStorage.removeItem(storageKey); } catch { /* Request metadata only. */ }
      }
    } catch (err) { if (err.name !== 'AbortError') setError(err.message || 'Unable to check sticky sheet status.'); }
  }, [apiBase, deviceId, storageKey]);
  useEffect(() => {
    setSnapshot(null); setDraft(null);
    try { const saved = JSON.parse(sessionStorage.getItem(storageKey)); if (saved?.device_id === deviceId) setDraft(saved); } catch { /* Storage may be disabled. */ }
    const controller = new AbortController();
    refresh(controller.signal);
    return () => controller.abort();
  }, [refresh, deviceId, storageKey]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') refresh(controller.signal);
    }, snapshot?.request?.status === 'pending' ? 60000 : 300000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [refresh, snapshot?.request?.status]);
  const request = snapshot?.request;
  const pending = request?.status === 'pending';
  const retry = request?.status === 'failed' || Boolean(draft);
  const stats = usage(snapshot?.state);
  const date = value => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone || 'Asia/Kolkata' }).format(new Date(value));
  function close() {
    if (submitting.current) return;
    dialog.current.close(); setStep(0); setConfirmed(false); setToken(''); trigger.current?.focus();
  }
  function open() {
    setStep(0); setConfirmed(false); setToken(''); dialog.current.showModal();
  }
  async function submit() {
    if (!canSubmit(step, confirmed) || submitting.current || pending || !snapshot?.enabled || !token.trim()) return;
    const payload = request?.status === 'failed' ? requestFromRow(request) : draft || newRequest(deviceId);
    submitting.current = true; setBusy(true); setError(''); setDraft(payload);
    try {
      // Preserve the same ID across a lost response/reload; never store the authorization key.
      sessionStorage.setItem(storageKey, JSON.stringify(payload));
    } catch { /* In-memory duplicate protection remains available. */ }
    try {
      const response = await fetch(`${apiBase}/api/sticky-sheet`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...payload, retry: Boolean(retry) }) });
      const body = await response.json();
      if (!response.ok || !body.request || body.request.device_id !== deviceId || !['pending', 'failed', 'completed'].includes(body.request.status)) throw new Error(response.status === 401 ? 'Replacement key was not accepted. Retry using the same request.' : 'Request could not be confirmed. Retry safely with the same request ID.');
      setSnapshot(current => ({ ...current, request: body.request }));
      setDraft(null);
      try { sessionStorage.removeItem(storageKey); } catch { /* Metadata only. */ }
      dialog.current.close(); setStep(0); setConfirmed(false); trigger.current?.focus();
      await refresh();
    } catch (err) { setError(err.message || 'Unable to register replacement. Retry with the same request ID.'); }
    finally { submitting.current = false; setBusy(false); setToken(''); }
  }
  return <section className="panel sticky-sheet-panel" aria-labelledby="sticky-sheet-title">
    <div className="panel-heading"><div><p className="eyebrow">Device maintenance</p><h3 id="sticky-sheet-title">Sticky Sheet Status</h3></div>
      <button ref={trigger} className="primary-button" disabled={!snapshot?.enabled || pending || busy} onClick={open}>{busy ? 'Submitting…' : retry ? 'Retry Replacement Request' : 'Replace Sticky Sheet'}</button></div>
    <div className={`health-status ${pending || request?.status === 'failed' ? 'sheet-pending' : ''}`} role="status">{snapshot ? snapshot.enabled ? sheetStatus(request) : 'Status unavailable – replacement registration not enabled' : 'Loading sticky sheet status…'}</div>
    {confirmedSuccess(request) && <p className="sheet-success" role="status">New Sticky Sheet Registered Successfully<br /><span>Confirmed {date(request.acknowledged_at)}</span></p>}
    <div className="sheet-metrics">
      <div><span>Estimated sheet usage</span><strong>{stats.days === null ? 'Not available' : `${stats.days} days`}</strong></div>
      <div><span>Completed sheet advances</span><strong>{snapshot?.state?.completed_advances ?? 'Not available'}</strong></div>
      <div><span>Estimated remaining (90-day maximum)</span><strong>{stats.remaining === null ? 'Not available' : `${stats.remaining} days`}</strong></div>
    </div>
    <p className="muted">Estimates are based on the last confirmed registration, not physical condition. Replacement may be needed before 90 days. Elapsed time alone does not confirm exhaustion.</p>
    {pending && <p className="muted">The Raspberry Pi will process this request during its next normal scheduled wake-up. If offline, the request stays pending. Usage does not reset until successful device acknowledgement.</p>}
    {request?.status === 'failed' && <p className="sheet-warning" role="alert">The device reported a processing failure. Usage has not been reset by this dashboard. Retry reuses this request ID.</p>}
    {snapshot && !snapshot.enabled && <p className="muted">Registration is disabled until secure backend and device acknowledgement support are configured.</p>}
    {error && <div className="alert error-alert" role="alert"><span>{error}</span><button className="text-button" onClick={() => refresh()}>Check status</button></div>}
    <dialog ref={dialog} className="sheet-dialog" aria-labelledby="sheet-dialog-title" aria-describedby="sheet-question" onCancel={event => { event.preventDefault(); close(); }}>
      <p className="eyebrow">Step {step + 1} of 3</p>
      <h3 id="sheet-dialog-title">{['Physical replacement confirmation', 'Installation verification', 'Final confirmation'][step]}</h3>
      <p className="sheet-warning"><strong>Physically replace the roller first.</strong> This form only registers your confirmation. It does not wake or operate the device.</p>
      <p id="sheet-question">{QUESTIONS[step]}</p>
      <label className="sheet-checkbox"><input autoFocus type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />{['Yes, I have physically replaced the sticky sheet roller.', 'Yes, it is installed, aligned, and ready.', 'Yes, register this as a new sticky sheet.'][step]}</label>
      {step === 2 && <label className="sheet-key">Replacement authorization key<input type="password" value={token} autoComplete="off" disabled={busy} onChange={event => setToken(event.target.value)} /><span>Provided by your administrator. Never saved by this dashboard.</span></label>}
      {error && <p className="sheet-warning" role="alert">{error}</p>}
      <div className="sheet-dialog-actions"><button className="secondary-button" disabled={busy} onClick={close}>Cancel</button>
        {step < 2 ? <button className="primary-button" disabled={!confirmed} onClick={() => { setStep(advanceStep(step, confirmed)); setConfirmed(false); }}>Continue</button> : <button className="primary-button" disabled={!confirmed || !token.trim() || busy || pending} onClick={submit}>{busy ? 'Submitting…' : retry ? 'Retry Same Request' : 'Register Replacement'}</button>}</div>
    </dialog>
  </section>;
}
