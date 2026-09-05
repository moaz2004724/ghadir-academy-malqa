// Shared validation. This module deliberately has no browser or server dependencies.
export const RECOVERY_FORMAT = 'ghadir-recovery';
export const MAX_RECOVERY_BYTES = 5 * 1024 * 1024;
export const ENTITIES = ['players', 'coaches', 'groups', 'parents', 'payments', 'attendance', 'coachesAttendance', 'evals', 'messages', 'trainings', 'prices'];
export const legacyKey = /^(?:ghadir|royals|royal)_(players|coaches|groups|parents|payments|attendance|coachesAttendance|evals|messages|trainings|prices)$/;
const secretKey = /password|passwd|token|secret|authorization|cookie|credential/i;

export function cleanBusinessData(value, depth = 0) {
  if (depth > 30) throw new Error('الملف يحتوي على بيانات متداخلة أكثر من المسموح.');
  if (Array.isArray(value)) return value.map(v => cleanBusinessData(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (secretKey.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) continue;
      out[key] = cleanBusinessData(val, depth + 1);
    }
    return out;
  }
  return value;
}

export function validateSnapshot(input) {
  if (!input || input.format !== RECOVERY_FORMAT || input.version !== 1 || !Array.isArray(input.entries)) {
    throw new Error('اختَر ملف JSON تم تنزيله من أداة إنقاذ بيانات الأكاديمية.');
  }
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > MAX_RECOVERY_BYTES || input.entries.length > 200) throw new Error('حجم النسخة أكبر من المسموح (5 ميجابايت).');
  let origin;
  try {
    const url = new URL(input.origin);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    origin = url.origin;
  } catch { throw new Error('رابط مصدر النسخة غير صالح.'); }
  if (typeof input.capturedAt !== 'string' || !Number.isFinite(Date.parse(input.capturedAt))) throw new Error('تاريخ النسخة غير صالح.');
  const entries = input.entries.map(entry => {
    if (!entry || !ENTITIES.includes(entry.entity) || !['localStorage', 'sessionStorage', 'request'].includes(entry.store) || typeof entry.key !== 'string' || entry.key.length > 250) throw new Error('نوع بيانات غير مدعوم داخل النسخة.');
    if (!entry.data || typeof entry.data !== 'object') throw new Error('أحد أقسام النسخة لا يحتوي على سجلات صالحة.');
    if (entry.store !== 'request' && entry.entity !== 'prices' && (!Array.isArray(entry.data) || entry.data.some(row => !row || typeof row !== 'object' || Array.isArray(row)))) throw new Error('أحد أقسام النسخة لا يحتوي على قائمة سجلات صالحة.');
    return { store: entry.store, key: entry.key, entity: entry.entity, data: cleanBusinessData(entry.data) };
  });
  return {
    format: RECOVERY_FORMAT, version: 1, origin,
    capturedAt: new Date(input.capturedAt).toISOString(), entries,
    warnings: Array.isArray(input.warnings) ? input.warnings.filter(x => typeof x === 'string').slice(0, 100).map(x => x.slice(0, 300)) : [],
  };
}

export function snapshotCounts(snapshot) {
  const counts = {};
  for (const entry of snapshot.entries) counts[entry.entity] = (counts[entry.entity] || 0) + (Array.isArray(entry.data) ? entry.data.length : 1);
  return counts;
}

export function canonicalJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
