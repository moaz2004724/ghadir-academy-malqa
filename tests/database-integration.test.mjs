import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '../backend/node_modules/@prisma/client/default.js';
import bcrypt from '../backend/node_modules/bcryptjs/index.js';
import { prepareRecoverySchema } from '../backend/prepare-schema.js';

const databaseURL = process.env.RECOVERY_TEST_DATABASE_URL;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('real PostgreSQL: startup preserves existing data, archives persist, coach attendance survives a fresh read, backup is complete', { skip: !databaseURL, timeout: 40000 }, async t => {
  const url = new URL(databaseURL);
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname) && url.pathname === '/ghadir_recovery_test', 'Only the isolated local test database is allowed.');
  const prisma = new PrismaClient({datasources:{db:{url:databaseURL}}});
  const suffix = String(Date.now());
  const isolatedSchema = 'bootstrap_' + suffix;
  await prisma.$executeRawUnsafe(`CREATE SCHEMA ${isolatedSchema}`);
  const schemaURL = new URL(databaseURL); schemaURL.searchParams.set('schema', isolatedSchema);
  const isolated = new PrismaClient({ datasources: { db: { url: schemaURL.href } } });
  try {
    await Promise.all([prepareRecoverySchema(isolated), prepareRecoverySchema(isolated)]);
    assert.equal(await isolated.recoverySnapshot.count(), 0);
    assert.equal(await isolated.coachAttendance.count(), 0);
  } finally { await isolated.$disconnect(); }
  const adminId='recovery-admin-'+suffix;
  const password=bcrypt.hashSync('test-local-only',4);
  await prisma.user.create({data:{id:adminId,email:adminId+'@example.invalid',password,role:'ADMIN',name:'مدير اختبار'}});
  const group=await prisma.group.create({data:{id:'group-'+suffix,name:'مجموعة اختبار',price8:123,price12:234,price16:345}});
  const coachUser=await prisma.user.create({data:{email:'coach-'+suffix+'@example.invalid',password,role:'COACH',name:'مدرب اختبار'}});
  const coach=await prisma.coach.create({data:{userId:coachUser.id}});
  const beforeUsers=await prisma.user.count(); const beforeGroups=await prisma.group.count();
  for(let i=0;i<2;i++) execFileSync('psql',['-h','127.0.0.1','-p',url.port,'-d','ghadir_recovery_test','-v','ON_ERROR_STOP=1','-f',path.join(root,'backend/sql/001_recovery_archive.sql'),'-f',path.join(root,'backend/sql/002_coach_attendance.sql')],{stdio:'pipe'});

  const child=spawn(process.execPath,['index.js'],{cwd:path.join(root,'backend'),env:{...process.env,DATABASE_URL:databaseURL,PORT:'4319',JWT_SECRET:'local-integration-test-only'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  t.after(async()=>{child.kill('SIGTERM'); await prisma.$disconnect();});
  const base='http://127.0.0.1:4319';
  for(let i=0;i<80;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.equal(await prisma.user.count(),beforeUsers);assert.equal(await prisma.group.count(),beforeGroups);
  assert.equal((await prisma.user.findUnique({where:{id:adminId}})).password,password);
  assert.equal((await prisma.group.findUnique({where:{id:group.id}})).price8,123);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:adminId+'@example.invalid',password:'test-local-only'})});
  assert.equal(login.status,200,output);const {token}=await login.json();
  const headers={'Content-Type':'application/json',Authorization:`Bearer ${token}`};
  const fixture=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/old-branch-recovery.json')));
  const saved=await (await fetch(base+'/api/recovery/snapshots',{method:'POST',headers,body:JSON.stringify(fixture)})).json();
  assert.equal(saved.archived,true);
  const otherClient=new PrismaClient({datasources:{db:{url:databaseURL}}});
  try { assert.equal((await otherClient.recoverySnapshot.findUnique({where:{id:saved.id}})).payload.entries[0].data[0].name,'لاعب اختبار الإنقاذ'); } finally { await otherClient.$disconnect(); }
  const playerResponse = await fetch(base+'/api/players',{method:'POST',headers,body:JSON.stringify({name:'لاعب اختبار المزامنة',age:10,groupId:group.id,email:'parent-'+suffix+'@example.invalid'})});
  assert.equal(playerResponse.status,201); const player = await playerResponse.json();
  const paymentResponse = await fetch(base+'/api/payments',{method:'POST',headers,body:JSON.stringify({playerId:player.id,amount:300,month:'2026-09',type:'subscription'})});
  assert.equal(paymentResponse.status,201); const payment = await paymentResponse.json();
  const secondLogin = await (await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:adminId+'@example.invalid',password:'test-local-only'})})).json();
  for(const accessToken of [token, secondLogin.token]) {
    const fresh = await (await fetch(base+'/api/initial-data',{headers:{Authorization:`Bearer ${accessToken}`}})).json();
    assert.ok(fresh.players.some(row => row.id === player.id));
    assert.ok(fresh.payments.some(row => row.id === payment.id && row.playerId === player.id));
  }
  const priorPlayers=await prisma.player.count();
  const again=await (await fetch(base+'/api/recovery/snapshots',{method:'POST',headers,body:JSON.stringify(fixture)})).json();
  assert.equal(again.id,saved.id);assert.equal(await prisma.player.count(),priorPlayers);
  for(const date of ['2026-09-01','2026-09-02']){
    const res=await fetch(base+'/api/coach-attendance',{method:'POST',headers,body:JSON.stringify({date,records:{[coach.id]:'حاضر'}})});assert.equal(res.status,200);
  }
  assert.equal((await fetch(base+'/api/payments',{method:'POST',headers,body:JSON.stringify({playerId:'missing-legacy-player',amount:300})})).status,400);
  const changed=await fetch(base+'/api/coach-attendance',{method:'POST',headers,body:JSON.stringify({date:'2026-09-02',records:{[coach.id]:'بعذر'}})});assert.equal(changed.status,200);
  const initial=await (await fetch(base+'/api/initial-data',{headers})).json();
  assert.equal(initial.coachesAttendance.find(a=>a.date.startsWith('2026-09-01')).records[coach.id],'حاضر');
  assert.equal(initial.coachesAttendance.find(a=>a.date.startsWith('2026-09-02')).records[coach.id],'بعذر');
  assert.equal((await fetch(base+'/api/reset-database',{method:'POST',headers,body:'{}'})).status,410);
  const backupDir='/private/tmp/ghadir-recovery-backup-test';
  const backupOutput=execFileSync(process.execPath,['backup.js'],{cwd:path.join(root,'backend'),env:{...process.env,DATABASE_URL:databaseURL,BACKUP_DIR:backupDir},encoding:'utf8'});
  const manifest=JSON.parse(backupOutput);const backup=JSON.parse(fs.readFileSync(manifest.file,'utf8'));
  assert.ok(backup.data.auditLog);assert.ok(backup.data.recoverySnapshot);assert.ok(backup.data.coachAttendance);
  assert.equal(backup.counts.user,await prisma.user.count());assert.equal(fs.statSync(manifest.file).mode & 0o777,0o600);
});
