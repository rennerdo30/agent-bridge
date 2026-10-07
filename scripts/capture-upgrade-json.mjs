// Rebuild committed, synthetic disk fixtures using the actual released writers.
// This never opens the owner's home or installs any package.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tags = ['v0.27.0', 'v0.27.1', 'v0.28.0', 'v0.28.1', 'v0.28.2', 'v0.29.0', 'v0.29.10', 'v0.29.13', 'v0.29.14'];
const root = resolve(import.meta.dirname, '..');
const sourceRoot = process.env.AGENT_BRIDGE_UPGRADE_SOURCE_ROOT || 'D:/Development/agentbridge-upgrade-fixtures';
const out = join(root, 'test/fixtures/upgrade-json');
const fakeId = '11111111-1111-4111-8111-111111111111';
const now = () => 1700000000000;
const sha = raw => createHash('sha256').update(raw).digest('hex');
const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir,e.name)) : [join(dir,e.name)]);

for (const tag of tags) {
  const source = join(sourceRoot, tag);
  if (!existsSync(source)) execFileSync('git', ['worktree','add','--detach',source,tag], { cwd: root, stdio:'pipe' });
  const scratch = join(root,'.agent-bridge-test','upgrade-capture',`${tag}-${randomUUID()}`);
  const home = join(scratch,'home'); mkdirSync(home,{recursive:true});
  const module = async relative => {
    const entry = join(source, relative);
    const target = join(scratch, relative.replaceAll('/','_').replace(/\.ts$/,'.mjs'));
    await build({entryPoints:[entry],outfile:target,bundle:true,platform:'node',format:'esm',packages:'external',nodePaths:[join(root,'node_modules')]});
    return import(pathToFileURL(target).href);
  };
  const old = await module('src/core/json-store.ts');
  const records = {
    'jobs.json': {jobs:[{id:'kept-job',name:'codex-job-kept',agent:'codex',owner:'codex-source',rootName:'codex-source',rootSession:'root-session',state:'failed',prompt:'Retained task',startedAt:1700000000000,session:'native-thread',args:{model:'retained-model',future:{value:'keep'}},workdir:home,worktree:{path:join(home,'worktree'),repoRoot:home,branch:'saved-branch'},future:{unicode:'保存'}}],extension:{keep:true}},
    'config.json': {autoWake:false,maxJobs:4,codex:{wakeOnDirect:true},network:{enabled:false,name:'fixture-local',bind:'127.0.0.1',port:0,discovery:false},future:{nested:['keep','保存']}},
    'auto-wake.json': {peers:{'codex-source':true},future:'keep'},
    'read-state/session.json': {ids:['old-message'],readAt:1700000000000,future:'keep'},
    'job-outcomes/kept-job.json': {job:'codex-job-kept',decision:'keep',history:[{decision:'keep',at:1700000000000}],future:'keep'},
    'jobs/kept-job.spec.json': {job:'codex-job-kept',session:'native-thread',cwd:home,owner:'codex-source',args:{prompt:'Retained task'},future:'keep'},
    'jobs/kept-job.state.json': {status:'failed',session:'native-thread',error:'interrupted',future:'keep'},
    'message-waits/wait.json': {mode:'notify',from:'claude-source',conversationId:'retained-thread',future:'keep'},
    'archive/jobs-retained.json': {jobs:[{id:'archived-job',name:'opencode-job-archived',agent:'opencode',session:'archive-thread',state:'done',future:'keep'}]},
    'models-codex.json': {models:[{id:'retained-model',name:'Retained model'}],future:'keep'},
  };
  for (const [relative,value] of Object.entries(records)) { const p=join(home,relative); mkdirSync(dirname(p),{recursive:true}); old.writeJsonStore(p,value,null); }
  const feed = await module('src/core/runfeed.ts');
  const run = feed.startRunFeed({home,name:'codex-job-kept',header:'Recorded synthetic task',now,meta:{by:'codex-source',agent:'codex',session:'native-thread',continues:'previous-thread',workdir:home,branch:'saved-branch',repoRoot:home}});
  run.report('Original progress','Original progress with unicode 保存'); run.end('interrupted','Original answer retained');
  const pairing = await module('src/network/pairing.ts');
  const pair = new pairing.PairingStore(home,'fixture-local',now);
  const code = pairing.decodePairingCode(pair.invite());
  pair.accept(code.key,{id:fakeId,name:'fixture-remote',fingerprint:'a'.repeat(64)}); pair.invite();
  const relay = await module('src/core/relay.ts');
  const stop = relay.publishApproval ? await relay.publishApproval(home,{id:fakeId,owner:'codex-source',job:'codex-job-kept',agent:'codex',tool:'Write',command:'retained approval',reason:'Owner decision pending',askedAt:now(),deadline:now()+60000},()=>false) : () => {};
  // Capture while pending, then stop the synthetic callback. No answer is sent.
  const destination=join(out,tag); mkdirSync(destination,{recursive:true});
  const captured=[];
  for (const p of files(home)) {
    const rel=p.slice(home.length+1).replaceAll('\\','/');
    if (!/\.(json|log|jsonl)$/.test(rel)) continue;
    let bytes=readFileSync(p);
    // Paths belong to the synthetic fixture, never the owner's machine.
    bytes=Buffer.from(bytes.toString().replaceAll(home.replaceAll('\\','\\\\'),'__FIXTURE_HOME__').replaceAll(home,'__FIXTURE_HOME__'));
    const target=join(destination,rel); mkdirSync(dirname(target),{recursive:true}); writeFileSync(target,bytes);
    captured.push({path:rel,bytes:bytes.length,sha256:sha(bytes)});
  }
  stop();
  writeFileSync(join(destination,'manifest.json'),JSON.stringify({tag,commit:execFileSync('git',['rev-parse',tag],{cwd:root,encoding:'utf8'}).trim(),jsonVersion:old.JSON_STORE_VERSION,pendingApprovalStore:!!relay.publishApproval,source:'Released json-store, runfeed, pairing and available relay writers executed in isolated tagged worktree',files:captured},null,2)+'\n');
  process.stdout.write(`${tag}: ${captured.length} synthetic files captured\n`);
}
