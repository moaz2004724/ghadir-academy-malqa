import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSnapshot, canonicalJSON } from '../backend/recovery-format.js';
import { scanLegacyStorage, preserveSnapshot, protectLegacyData, listLocalSnapshots, SNAPSHOT_PREFIX, REQUEST_PREFIX } from '../recovery/storage.js';

export class MemoryStorage {
  map = new Map();
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.get(k) ?? null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
function host() { return { location: { origin: 'https://branch.example' }, localStorage: new MemoryStorage(), sessionStorage: new MemoryStorage() }; }
function sample() { const h = host(); h.localStorage.setItem('ghadir_players', JSON.stringify([{ id: 'p1', name: 'Test child', password: 'never-export', parent: { token: 'never-export', phone: 'test' } }])); return { h, snapshot: scanLegacyStorage(h) }; }

test('captures local and session business data, excludes authentication, preserves exact originals', () => {
  const { h } = sample(); const original = h.localStorage.getItem('ghadir_players');
  h.localStorage.setItem('ghadir_token', 'not-exported'); h.localStorage.setItem('unrelated_app', '[1]');
  h.sessionStorage.setItem('royals_payments', '[{"id":"pay1","amount":300}]');
  const snapshot = scanLegacyStorage(h);
  assert.equal(snapshot.entries.length, 2);
  assert.ok(!JSON.stringify(snapshot).includes('never-export'));
  assert.equal(snapshot.entries[0].data[0].parent.phone, 'test');
  assert.equal(h.localStorage.getItem('ghadir_players'), original);
  assert.equal(h.localStorage.getItem('ghadir_token'), 'not-exported');
});
test('snapshots are immutable, deduplicated across reloads and separated by origin', () => {
  const { h, snapshot } = sample();
  const first = preserveSnapshot(snapshot, h.localStorage);
  const second = preserveSnapshot({ ...snapshot, capturedAt: new Date(1).toISOString() }, h.localStorage);
  assert.equal(first.key, second.key);
  preserveSnapshot({ ...snapshot, origin: 'https://other.example' }, h.localStorage);
  assert.equal(listLocalSnapshots(h.localStorage).length, 2);
  assert.equal(JSON.parse(h.localStorage.getItem(first.key)).capturedAt, snapshot.capturedAt);
});
test('invalid JSON and quota exhaustion never remove original business data', () => {
  const { h } = sample();
  h.localStorage.setItem('ghadir_payments', '{broken');
  const before = new Map(h.localStorage.map);
  h.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  const snapshot = protectLegacyData(h);
  assert.equal(snapshot.entries.length, 1); assert.equal(snapshot.warnings.length, 1);
  assert.deepEqual(h.localStorage.map, before);
});
test('rejects foreign formats, invalid row shapes, unsafe origins and strips nested secrets/prototype keys', () => {
  const { snapshot } = sample();
  assert.throws(() => validateSnapshot({ players: [] }));
  assert.throws(() => validateSnapshot({ ...snapshot, origin: 'javascript:alert(1)' }));
  assert.throws(() => validateSnapshot({ ...snapshot, entries: [{ ...snapshot.entries[0], data: [null] }] }));
  const data = JSON.parse('[{"id":"p","__proto__":{"polluted":true},"password":"x","nested":{"encryptedPassword":"x","phone":"test"}}]');
  const result = validateSnapshot({ ...snapshot, entries: [{ ...snapshot.entries[0], data }] });
  assert.equal({}.polluted, undefined); assert.ok(!JSON.stringify(result).includes('Password'));
  assert.ok(!JSON.stringify(result).includes('__proto__'));
  assert.equal(result.entries[0].data[0].nested.phone, 'test');
});
test('UTF-8 byte size is enforced for Arabic files and canonical identity ignores object key order', () => {
  const { snapshot } = sample();
  assert.throws(() => validateSnapshot({ ...snapshot, warnings: ['ع'.repeat(3 * 1024 * 1024)] }));
  assert.equal(canonicalJSON({ b: 2, a: [1] }), canonicalJSON({ a: [1], b: 2 }));
});

test('failed writes survive refresh; success removes only its own journal; no false saved status', async () => {
  const storage = new MemoryStorage(); const events = new EventTarget();
  globalThis.localStorage = storage;
  globalThis.window = Object.assign(events, { location: { origin: 'https://branch.example' }, localStorage: storage });
  const { apiFetch, getWriteStatus } = await import('../recovery/api.js?case=failure');
  storage.setItem('ghadir_players', '[{"id":"old"}]'); storage.setItem(SNAPSHOT_PREFIX + 'keep', 'untouched');
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  await apiFetch('/api/payments', { method: 'POST', body: '{"amount":300,"password":"secret"}' });
  assert.equal(getWriteStatus(), 'error');
  const failedKey = [...storage.map.keys()].find(x => x.startsWith(REQUEST_PREFIX));
  assert.ok(failedKey); assert.ok(!storage.getItem(failedKey).includes('secret'));
  globalThis.fetch = async () => new Response('{"id":"new"}', { status: 201 });
  await apiFetch('/api/players', { method: 'POST', body: '{"name":"test"}' });
  assert.equal(getWriteStatus(), 'error', 'a successful request must not hide another failed request');
  assert.ok(storage.getItem(failedKey)); assert.equal(storage.getItem(SNAPSHOT_PREFIX + 'keep'), 'untouched');
  assert.equal(storage.getItem('ghadir_players'), '[{"id":"old"}]');
  globalThis.fetch = async () => { throw new Error('connection lost after commit'); };
  await assert.rejects(apiFetch('/api/payments', { method: 'POST', body: '{"amount":400}' }));
  assert.equal([...storage.map.keys()].filter(x => x.startsWith(REQUEST_PREFIX)).length, 2);
  delete globalThis.window; delete globalThis.localStorage;
});
test('storage failure blocks the network write rather than pretending it is protected', async () => {
  const storage = new MemoryStorage(); storage.setItem = () => { throw new Error('quota'); };
  globalThis.localStorage = storage; globalThis.window = Object.assign(new EventTarget(), { location: { origin: 'https://branch.example' }, localStorage: storage });
  let calls = 0; globalThis.fetch = async () => { calls++; return new Response('{}'); };
  const { apiFetch, getWriteStatus } = await import('../recovery/api.js?case=quota');
  await assert.rejects(apiFetch('/api/players', { method: 'POST', body: '{"name":"test"}' }));
  assert.equal(calls, 0); assert.equal(getWriteStatus(), 'error');
  delete globalThis.window; delete globalThis.localStorage;
});

test('standalone old-site exporter reads both stores without network access or modifying originals', async () => {
  const { readFileSync } = await import('node:fs'); const { runInNewContext } = await import('node:vm');
  const { h } = sample(); h.sessionStorage.setItem('royals_payments','[{"id":"pay","amount":300}]');
  const beforeLocal = [...h.localStorage.map]; const beforeSession = [...h.sessionStorage.map];
  let exported, clicked=false;
  const context={window:h,location:{origin:h.location.origin,hostname:'branch.example'},Blob,Date,JSON,Object,Array,RegExp,
    URL:{createObjectURL:blob=>{exported=blob;return 'blob:test';},revokeObjectURL:()=>{}},
    document:{createElement:()=>({click:()=>{clicked=true;}})},setTimeout:fn=>fn(),alert:()=>{throw new Error('Unexpected empty-export notice');}};
  runInNewContext(readFileSync(new URL('../public/recovery-export.js',import.meta.url),'utf8'),context);
  const snapshot=validateSnapshot(JSON.parse(await exported.text()));
  assert.equal(snapshot.entries.length,2);assert.equal(clicked,true);
  assert.deepEqual([...h.localStorage.map],beforeLocal);assert.deepEqual([...h.sessionStorage.map],beforeSession);
  assert.ok(!JSON.stringify(snapshot).includes('never-export'));
});

test('HTTP 200 with an HTML page is not accepted as a saved database record', async () => {
  const storage=new MemoryStorage(); globalThis.localStorage=storage;
  globalThis.window=Object.assign(new EventTarget(),{location:{origin:'https://branch.example'},localStorage:storage});
  const {apiFetch,getWriteStatus}=await import('../recovery/api.js?case=html');
  globalThis.fetch=async()=>new Response('<html>fallback</html>',{status:200,headers:{'Content-Type':'text/html'}});
  await assert.rejects(apiFetch('/api/players',{method:'POST',body:'{"name":"test"}'}));
  assert.equal(getWriteStatus(),'error'); assert.equal(storage.length,1);
  delete globalThis.window;delete globalThis.localStorage;
});
