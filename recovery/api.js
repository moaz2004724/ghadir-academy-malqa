import { cleanBusinessData } from '../backend/recovery-format.js';
import { REQUEST_PREFIX, reportRecoveryWarning, listUnconfirmedRequests } from './storage.js';

let activeWrites = 0;
let unpersistedFailure = false;
export function getWriteStatus() {
  if (unpersistedFailure) return 'error';
  if (activeWrites > 0) return 'syncing';
  try { return listUnconfirmedRequests().length ? 'error' : 'synced'; } catch { return 'error'; }
}

// Keep a recovery copy before a write leaves this browser. No automatic replay:
// a lost response can mean the server already committed the request.
export async function apiFetch(input, init = {}) {
  const method = (init.method || 'GET').toUpperCase();
  const url = new URL(input, window.location.origin);
  const entity = /^\/api\/(players|coaches|groups|payments|attendance|coach-attendance|evaluations|messages|trainings)(?:\/[^/]+)?$/.exec(url.pathname)?.[1];
  if (!entity || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return fetch(input, init);
  const key = REQUEST_PREFIX + crypto.randomUUID();
  let record;
  try {
    record = { entity: entity === 'evaluations' ? 'evals' : entity === 'coach-attendance' ? 'coachesAttendance' : entity, path: url.pathname, method, capturedAt: new Date().toISOString(), data: cleanBusinessData(init.body ? JSON.parse(init.body) : {}), status: 'unconfirmed' };
    const serialized = JSON.stringify(record);
    localStorage.setItem(key, serialized);
    if (localStorage.getItem(key) !== serialized) throw new Error('Storage verification failed');
  } catch {
    unpersistedFailure = true;
    reportRecoveryWarning('تعذّر حفظ نسخة من الطلب على الجهاز. لم نرسل التعديل؛ نزّل بيانات الإنقاذ ووفّر مساحة ثم أعد المحاولة.');
    throw new Error('تعذّر تأمين نسخة محلية من الطلب.');
  }
  activeWrites++;
  window.dispatchEvent(new Event('ghadir-recovery-change'));
  try {
    const response = await fetch(input, init);
    if (response.ok && (method !== 'DELETE' || response.status !== 204)) {
      const confirmation = await response.clone().json().catch(() => null);
      if (!confirmation || typeof confirmation !== 'object' || (!confirmation.id && confirmation.success !== true)) throw new Error('رد السيرفر لا يؤكد حفظ السجل.');
    }
    if (response.ok || (method === 'DELETE' && response.status === 404)) {
      // Remove only this confirmed request, never a legacy record or recovery snapshot.
      localStorage.removeItem(key);
    } else {
      record.status = 'rejected'; record.httpStatus = response.status;
      localStorage.setItem(key, JSON.stringify(record));
    }
    return response;
  } catch (error) {
    // Retain the original request; do not claim it failed to reach the server.
    throw error;
  } finally { activeWrites--; window.dispatchEvent(new Event('ghadir-recovery-change')); }
}
