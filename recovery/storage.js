import { RECOVERY_FORMAT, legacyKey, cleanBusinessData, validateSnapshot, canonicalJSON } from '../backend/recovery-format.js';

export const SNAPSHOT_PREFIX = 'ghadir_recovery_snapshot_v1:';
export const REQUEST_PREFIX = 'ghadir_recovery_request_v1:';
export const recoveryState = { warnings: [] };
const signal = () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event('ghadir-recovery-change')); };
export function reportRecoveryWarning(message) {
  if (!recoveryState.warnings.includes(message)) recoveryState.warnings.push(message);
  signal();
}
export function scanLegacyStorage(host = window) {
  const snapshot = { format: RECOVERY_FORMAT, version: 1, origin: host.location.origin, capturedAt: new Date().toISOString(), entries: [], warnings: [] };
  for (const store of ['localStorage', 'sessionStorage']) {
    try {
      const storage = host[store];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        const match = legacyKey.exec(key);
        if (!match) continue;
        try {
          const data = JSON.parse(storage.getItem(key));
          if (data && typeof data === 'object' && Object.keys(data).length) snapshot.entries.push({ store, key, entity: match[1], data: cleanBusinessData(data) });
        } catch { snapshot.warnings.push(`تعذّرت قراءة ${key}؛ الأصل ما زال محفوظًا ولم نغيّره.`); }
      }
    } catch { snapshot.warnings.push(`المتصفح لا يسمح بقراءة ${store}.`); }
  }
  return snapshot;
}
export function listLocalSnapshots(storage = window.localStorage) {
  const snapshots = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(SNAPSHOT_PREFIX)) continue;
    try { snapshots.push({ key, snapshot: validateSnapshot(JSON.parse(storage.getItem(key))) }); } catch { /* Keep damaged originals untouched. */ }
  }
  return snapshots.sort((a, b) => b.snapshot.capturedAt.localeCompare(a.snapshot.capturedAt));
}
export function preserveSnapshot(input, storage = window.localStorage) {
  const snapshot = validateSnapshot(input);
  const identity = canonicalJSON({ origin: snapshot.origin, entries: snapshot.entries });
  const existing = listLocalSnapshots(storage).find(item => canonicalJSON({ origin: item.snapshot.origin, entries: item.snapshot.entries }) === identity);
  if (existing) return existing;
  const key = SNAPSHOT_PREFIX + crypto.randomUUID();
  const serialized = JSON.stringify(snapshot);
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized) throw new Error('تعذّر التحقق من النسخة المحلية.');
  signal();
  return { key, snapshot };
}
export function protectLegacyData(host = window) {
  const snapshot = scanLegacyStorage(host);
  for (const warning of snapshot.warnings) reportRecoveryWarning(warning);
  if (snapshot.entries.length) {
    try { preserveSnapshot(snapshot, host.localStorage); }
    catch { reportRecoveryWarning('تعذّر إنشاء نسخة حماية محلية؛ قد تكون المساحة ممتلئة. نزّل نسخة من أداة الإنقاذ الآن. البيانات الأصلية لم تُمسح.'); }
  }
  return snapshot;
}
export function downloadJSON(data, filename = 'ghadir-recovery.json') {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function listUnconfirmedRequests(storage = window.localStorage) {
  const result = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(REQUEST_PREFIX)) continue;
    try { result.push({ key, ...JSON.parse(storage.getItem(key)) }); } catch { /* Never delete unreadable data. */ }
  }
  return result;
}
