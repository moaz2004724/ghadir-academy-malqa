import test from 'node:test';
import assert from 'node:assert/strict';
import { startLiveRefresh, keepUnchanged, canApplyRead, isEditingPage } from '../sync/live-refresh.js';

function clock() {
  let now=0, id=0; const jobs=new Map();
  return {
    setTimeout(fn, delay) { const key=++id;jobs.set(key,{fn,at:now+delay});return key; },
    clearTimeout(key) { jobs.delete(key); },
    async advance(ms) {
      now+=ms;
      const due=[...jobs].filter(([,job])=>job.at<=now);
      for(const [key,job] of due) { if(jobs.delete(key))job.fn(); }
      for(let i=0;i<8;i++)await Promise.resolve();
    },
    jobs,
  };
}
function client(refresh, canRefresh=()=>true) {
  const timers=clock(), win=new EventTarget(), doc=Object.assign(new EventTarget(),{hidden:false});
  const stop=startLiveRefresh({refresh,canRefresh,windowTarget:win,documentTarget:doc,timers});
  return {timers,win,doc,stop};
}
test('two open clients automatically receive new players and payments without a reload or manual fetch', async()=>{
  let server={players:[],payments:[]}, viewA,viewB;
  const a=client(async()=>viewA=structuredClone(server)), b=client(async()=>viewB=structuredClone(server));
  await a.timers.advance(3000);await b.timers.advance(3000);
  server.players.push({id:'p1'});server.payments.push({id:'pay1',playerId:'p1'});
  await a.timers.advance(3000);await b.timers.advance(3000);
  assert.deepEqual(viewA,server);assert.deepEqual(viewB,server);a.stop();b.stop();
});
test('hidden tabs and unconfirmed writes/drafts pause reads; focus and online wake them immediately',async()=>{
  let blocked=true,calls=0;
  const c=client(async()=>{calls++;return {};},()=>!blocked);
  await c.timers.advance(3000);assert.equal(calls,0);
  blocked=false;c.doc.hidden=true;await c.timers.advance(3000);assert.equal(calls,0);
  c.doc.hidden=false;c.doc.dispatchEvent(new Event('visibilitychange'));await c.timers.advance(0);assert.equal(calls,1);
  c.win.dispatchEvent(new Event('online'));await c.timers.advance(0);assert.equal(calls,2);c.stop();
});
test('polls do not overlap and stop aborts the pending read and removes listeners',async()=>{
  let resolve,signal,calls=0;
  const c=client(options=>{calls++;signal=options.signal;return new Promise(r=>resolve=r);});
  await c.timers.advance(3000);c.win.dispatchEvent(new Event('focus'));await c.timers.advance(3000);
  assert.equal(calls,1);c.stop();assert.equal(signal.aborted,true);resolve({});await c.timers.advance(0);
  c.win.dispatchEvent(new Event('focus'));await c.timers.advance(3000);assert.equal(calls,1);assert.equal(c.timers.jobs.size,0);
});
test('network failures back off and a returning connection resumes without a reload',async()=>{
  let calls=0,online=false;
  const c=client(async()=>{calls++;if(!online)throw new Error('offline');return {};});
  await c.timers.advance(3000);assert.equal(calls,1);
  await c.timers.advance(3000);assert.equal(calls,1);
  await c.timers.advance(3000);assert.equal(calls,2);
  online=true;c.win.dispatchEvent(new Event('online'));await c.timers.advance(0);assert.equal(calls,3);
  await c.timers.advance(3000);assert.equal(calls,4);c.stop();
});
test('stale responses cannot overwrite a write, a newer read, a new session, or a draft opened during the fetch',()=>{
  const valid={sequence:1,latestSequence:1,session:'a',currentSession:'a',generation:2,currentGeneration:2,background:true,blocked:false,aborted:false};
  assert.equal(canApplyRead(valid),true);
  for(const change of [{latestSequence:2},{currentSession:'b'},{currentGeneration:3},{blocked:true},{aborted:true}])assert.equal(canApplyRead({...valid,...change}),false);
  assert.equal(canApplyRead({...valid,background:false,blocked:true}),true,'explicit post-save refresh may update a form');
});
test('unchanged collections retain identity so form effects do not run again on every poll',()=>{
  const current=[{id:'a',name:'player'}];assert.equal(keepUnchanged(current,structuredClone(current)),current);
  const next=[...current,{id:'b'}];assert.equal(keepUnchanged(current,next),next);
  assert.equal(isEditingPage({querySelector:()=>({}),activeElement:null}),true);
  assert.equal(isEditingPage({querySelector:()=>null,activeElement:{matches:()=>true}}),true);
  assert.equal(isEditingPage({querySelector:()=>null,activeElement:{matches:()=>false}}),false);
});

test('App wiring actually polls while idle and rejects responses overtaken by a local save', async () => {
  const { readFile } = await import('node:fs/promises');
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(new URL('../ghadir_academy.jsx', import.meta.url), 'utf8');
  // Execute the actual App loader and its effects with controlled hook/browser boundaries.
  const start = source.indexOf('  const loadInitialData = useCallback(');
  const end = source.indexOf('  useEffect(() => {\n    const timer = setTimeout', start);
  assert.ok(start > 0 && end > start);
  const timers = clock(), win = new EventTarget(), doc = Object.assign(new EventTarget(), { hidden: false });
  const effects = [], state = {};
  let generation = 0, blocked = false, server = { players: [{ id: 'p1' }], payments: [] }, resolveRead;
  const context = {
    useCallback: fn => fn, useEffect: fn => effects.push(fn),
    token: 'test', user: { id: 'u1' }, API_URL: '',
    loadSequenceRef: { current: 0 }, currentSessionRef: { current: 'u1:test' },
    backgroundBlocked: () => blocked, getWriteGeneration: () => generation,
    getWriteStatus: () => 'synced', canApplyRead, keepUnchanged,
    apiFetch: async () => resolveRead ? new Promise(resolve => { resolveRead.resolve = resolve; }) : ({ ok: true, json: async () => structuredClone(server) }),
    startLiveRefresh: options => startLiveRefresh({ ...options, timers, windowTarget: win, documentTarget: doc }),
    localStorage: { getItem: () => 'test', removeItem() {} }, sessionStorage: { removeItem() {} }, console
  };
  for (const name of ['Players','Payments','Coaches','Groups','Attendance','CoachesAttendance','Evals','Messages','Trainings','Parents','SyncStatus','IsAppLoading','User','Token']) {
    context['set' + name] = value => state[name] = typeof value === 'function' ? value(state[name] || []) : value;
  }
  runInNewContext(source.slice(start, end) + '\nglobalThis.read = loadInitialData;', context);
  await context.read(); assert.equal(state.Players[0].id, 'p1');
  const stop = effects[1]();
  server = { players: [{ id: 'p1' }, { id: 'p2' }], payments: [{ id: 'pay1' }] };
  await timers.advance(3000);
  assert.equal(state.Players.length, 2); assert.equal(state.Payments[0].id, 'pay1');
  blocked = true; server.players.push({ id: 'p3' }); await timers.advance(3000);
  assert.equal(state.Players.length, 2);
  blocked = false; resolveRead = {};
  const stale = context.read({ background: true }); generation++;
  resolveRead.resolve({ ok: true, json: async () => ({ players: [] }) }); await stale;
  assert.equal(state.Players.length, 2, 'response started before a save must not replace current data');
  stop();
});
