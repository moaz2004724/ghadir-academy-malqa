import test from 'node:test';
import assert from 'node:assert/strict';
import express from '../backend/node_modules/express/index.js';
import { createRecoveryRouter } from '../backend/recovery-routes.js';

test('authenticated archive is idempotent across devices, immutable, paginated, and never merges business records', async t => {
  const snapshots = new Map(); let failDB = false;
  const operational = { players: [{ id: 'production-sentinel', name: 'Do not touch' }] };
  const before = JSON.stringify(operational);
  const prisma = { recoverySnapshot: {
    async upsert({where, create}) { if(failDB) throw new Error('offline'); if(!snapshots.has(where.id)) snapshots.set(where.id, {...create, createdAt:new Date()}); return snapshots.get(where.id); },
    async findMany({skip,take}) { return [...snapshots.values()].slice(skip, skip+take); },
    async findUnique({where}) { return snapshots.get(where.id) || null; },
  } };
  const auth = (req,res,next) => { const role = req.headers['x-test-role']; if(!role)return res.status(401).json({error:'unauthorized'}); req.user={id:'admin-test',role};next(); };
  const roles = allowed => (req,res,next) => allowed.includes(req.user.role) ? next() : res.status(403).json({error:'forbidden'});
  const app = express(); app.use('/api/recovery', createRecoveryRouter({prisma, authenticateToken:auth, requireRole:roles}));
  const server = await new Promise(resolve => { const s=app.listen(0,'127.0.0.1',()=>resolve(s)); });
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}/api/recovery`;
  const snapshot={format:'ghadir-recovery',version:1,origin:'https://old-branch.example',capturedAt:new Date().toISOString(),entries:[{store:'localStorage',key:'royals_players',entity:'players',data:[{id:'old',name:'Recovered test',password:'must-strip'}]}]};
  const headers={'Content-Type':'application/json','x-test-role':'ADMIN'};
  assert.equal((await fetch(base+'/snapshots')).status,401);
  assert.equal((await fetch(base+'/snapshots',{headers:{'x-test-role':'COACH'}})).status,403);
  assert.equal((await fetch(base+'/snapshots',{method:'POST',headers:{...headers,'x-test-role':'PARENT'},body:JSON.stringify(snapshot)})).status,403);
  const first=await fetch(base+'/snapshots',{method:'POST',headers,body:JSON.stringify(snapshot)});
  assert.equal(first.status,201);const record=await first.json();assert.equal(record.archived,true);assert.equal(record.merged,false);
  const repeated=await (await fetch(base+'/snapshots',{method:'POST',headers,body:JSON.stringify({...snapshot,capturedAt:new Date(1).toISOString()})})).json();
  assert.equal(repeated.id,record.id); assert.equal(snapshots.size,1);
  const otherDevice=await (await fetch(base+'/snapshots/'+record.id,{headers:{'x-test-role':'ADMIN'}})).json();
  assert.equal(otherDevice.payload.entries[0].data[0].name,'Recovered test'); assert.equal(otherDevice.payload.entries[0].data[0].password,undefined);
  assert.equal(otherDevice.payload.capturedAt,snapshot.capturedAt);
  assert.equal((await fetch(base+'/snapshots/missing',{headers})).status,404);
  assert.equal((await fetch(base+'/snapshots',{method:'POST',headers,body:'{"format":"other"}'})).status,400);
  const list=await (await fetch(base+'/snapshots?page=0',{headers})).json();assert.equal(list.items.length,1);assert.equal(list.hasMore,false);
  failDB=true;
  assert.equal((await fetch(base+'/snapshots',{method:'POST',headers,body:JSON.stringify(snapshot)})).status,503);
  assert.equal(JSON.stringify(operational),before);
});
