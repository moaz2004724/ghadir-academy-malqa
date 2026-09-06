import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('permission switch handles legacy defaults, waits for confirmation and prevents duplicate saves', async () => {
  const source = await readFile(new URL('../ghadir_academy.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const togglePerm = async');
  const end = source.indexOf('  const handleDeleteCoach', start);
  const coach = {id:'c1',perms:null};
  let sent=[], pending, refreshes=0, error='', saving=false;
  const context = {
    coaches:[coach], permissionSaveRef:{current:false},
    setPermissionSaving:value=>saving=value, setPermissionError:value=>error=value,
    getAuthToken:()=> 'local-test',
    apiFetch:async (url,options)=> {sent.push({url,...JSON.parse(options.body)});return new Promise(resolve=>pending=resolve);},
    loadInitialData:async()=>{refreshes++;}
  };
  runInNewContext(source.slice(start,end)+'\nglobalThis.toggle = togglePerm;',context);
  const first=context.toggle('c1','payments');
  assert.equal(saving,true);assert.equal(sent[0].perms.payments,false);
  assert.equal(Object.keys(sent[0].perms).length,1);
  assert.equal(coach.perms,null,'do not optimistically replace the saved permissions');
  await context.toggle('c1','attendance');assert.equal(sent.length,1);
  pending({ok:true,json:async()=>({id:'c1',perms:{payments:false}})});await first;
  assert.equal(refreshes,1);assert.equal(saving,false);assert.equal(error,'');
  coach.perms={payments:false};
  const second=context.toggle('c1','payments');assert.equal(sent[1].perms.payments,true);
  pending({ok:false});await second;
  assert.ok(error);assert.equal(refreshes,1);assert.equal(coach.perms.payments,false);
});
