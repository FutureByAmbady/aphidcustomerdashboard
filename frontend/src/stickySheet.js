export const ACTION = 'register_new_sticky_sheet';
export const QUESTIONS = [
  'Have you physically removed the old sticky sheet and installed a new sticky sheet roller?',
  'Please confirm that the new sticky sheet is properly installed, aligned, and ready for operation.',
  'Are you sure you want to register this as a new sticky sheet? This will reset the current sheet usage counter when the device next wakes up. Your project history, wind alignment records, and monitoring data will remain unchanged.',
];
export function advanceStep(step, confirmed) { return confirmed && step < 2 ? step + 1 : step; }
export function canSubmit(step, confirmed) { return step === 2 && confirmed; }
export function newRequest(deviceId) {
  return { device_id: deviceId, request_id: crypto.randomUUID(), requested_at: new Date().toISOString(), action: ACTION };
}
export function usage(state, now = Date.now()) {
  const start = Date.parse(state?.registered_at);
  const days = Number.isFinite(start) && start <= now ? Math.floor((now - start) / 86400000) : null;
  return { days, remaining: days === null ? null : Math.max(0, 90 - days) };
}
export function sheetStatus(request) {
  if (request?.status === 'pending') return 'Replacement Pending – Waiting for Device';
  if (request?.status === 'failed') return 'Replacement Pending – Processing Failed';
  return 'Active';
}
export function confirmedSuccess(request) { return request?.status === 'completed' && Number.isFinite(Date.parse(request.acknowledged_at)); }
export function requestFromRow(row) {
  return { device_id: row.device_id, request_id: row.request_id, requested_at: row.requested_at, action: ACTION };
}
