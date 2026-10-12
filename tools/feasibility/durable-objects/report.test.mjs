import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, symlink, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('report-write failure fails stdout and preserves an earlier assertion', async () => {
  const scratch=await mkdtemp(join(tmpdir(),'agent-comms-do-report-'));
  try {
    for(const name of ['probe.test.mjs','probe-worker.mjs','package.json','package-lock.json'])
      await copyFile(new URL(name,import.meta.url),join(scratch,name));
    await symlink(fileURLToPath(new URL('./node_modules',import.meta.url)),join(scratch,'node_modules'),'dir');
    const run=()=> {
      const env={...process.env,PROBE_REPORT:scratch};
      delete env.NODE_TEST_CONTEXT;
      const child=spawnSync(process.execPath,['--test','--test-timeout=120000',join(scratch,'probe.test.mjs')],{
        cwd:scratch,env,encoding:'utf8',timeout:130000,maxBuffer:1024*1024
      });
      assert.equal(child.error,undefined);
      assert.notEqual(child.status,0);
      const line=child.stdout.split('\n').map(line=>line.replace(/^# /,'')).find(line=>line.startsWith('{"scope":'));
      assert.ok(line,'child must emit structured report');
      const report=JSON.parse(line);
      assert.equal(report.pass,false);
      assert.equal(report.reportWriteFailure,'probe-report-write-failed');
      return report;
    };
    const writeFailure=run();
    assert.equal(writeFailure.failure.code,'probe-report-write-failed');
    assert.equal(writeFailure.cases.length,4);
    const worker=join(scratch,'probe-worker.mjs');
    const original=await readFile(worker,'utf8');
    const mutated=original.replace('WHERE id>? ORDER BY id LIMIT ?','WHERE id>? ORDER BY length(id),id LIMIT ?');
    assert.notEqual(mutated,original);
    await writeFile(worker,mutated);
    const originalFailure=run();
    assert.equal(originalFailure.failure.name,'AssertionError');
    assert.equal(originalFailure.failure.code,'ERR_ASSERTION');
    assert.equal(originalFailure.cases.length,3);
  } finally { await rm(scratch,{recursive:true,force:true}); }
});
