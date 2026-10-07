// Run only after the 0.30.0 tag and release CI are green:
// node docs/scripts/capture-dashboard.mjs --out docs/images
// Uses the release's actual dashboard HTML with synthetic API responses.
// No broker, agent CLI, installer, real store, or real project is started.
import { mkdtemp, mkdir, writeFile, readFile, access, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, extname } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { build } from '../../node_modules/esbuild/lib/main.js';

const repository = resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
if (outIndex < 0 || !args[outIndex + 1] || args.length !== 2) throw new Error('Usage: node docs/scripts/capture-dashboard.mjs --out docs/images');
const output = resolve(repository, args[outIndex + 1]);
const siteDirectory = join(repository, 'docs/dist');
await access(join(siteDirectory, 'index.html'));
const candidates = [
  join(process.env.ProgramFiles || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
  join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
  ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe')] : []),
  join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
];
let browser;
for (const candidate of candidates) {try {await access(candidate);browser=candidate;break;}catch {}}
if (!browser) throw new Error('No installed Chrome or Edge found. This script never installs a browser.');
const release = execFileSync('git', ['rev-parse', 'v0.30.0^{commit}'], {cwd:repository, encoding:'utf8'}).trim();
execFileSync('git', ['merge-base', '--is-ancestor', release, 'HEAD'], {cwd:repository});
const version = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')).version;
if (version !== '0.30.0') throw new Error('Capture requires the 0.30.0 product revision.');
const demo = await mkdtemp(join(tmpdir(), 'agent-bridge-docs-demo-'));
// AB-160: all writable runtime/browser files are under this independent temporary Git root.
execFileSync('git', ['init', '--quiet', demo]);
const bridgeHome = join(demo, 'bridge-home');
await mkdir(bridgeHome);
process.env.AGENT_BRIDGE_HOME = bridgeHome;
const modulePath = join(demo, 'dashboard.mjs');
await build({entryPoints:[join(repository,'src/cli/ui-page.ts')], outfile:modulePath, bundle:true, platform:'node', format:'esm'});
const { UI_PAGE } = await import(pathToFileURL(modulePath));
const now = Date.now();
const workspace = '/workspace/showcase';
const peer = (name, agent, extra = {}) => ({name, agent, cwd:workspace, startedAt:now-1500000, activity:'busy', version, sessionId:'demo-session-'+agent, projectGroup:'showcase', projectRoot:workspace, projectAddress:'project:showcase', ...extra});
const peers = [peer('claude-showcase','claude',{projectMain:true}), peer('codex-showcase','codex',{projectMain:false,activity:'idle'}), peer('opencode-notes','opencode',{cwd:'/workspace/notes',projectGroup:'notes',projectRoot:'/workspace/notes',projectMain:true}), peer('demo-laptop/codex-showcase','codex',{host:'demo-laptop',cwd:'/workspace/showcase',projectGroup:undefined})];
const run = (job, title, extra = {}) => ({name:job,job,title,agent:'codex',owner:'claude-showcase',by:'claude-showcase',rootName:'claude-showcase',model:'gpt-6-sol',effort:'high',access:'edit',permission:'workspace-write',startedAt:now-720000,updatedAt:now,status:'running',percent:68,etaAt:now+240000,progressNote:'Checking keyboard navigation',task:'Improve the settings page and verify keyboard navigation.',workdir:'/workspace/showcase/worktrees/settings',hasLog:false,...extra});
const runs = [run('codex-job-demo-settings','Polish settings and accessibility'),run('codex-job-demo-tests','Check keyboard navigation',{parentJob:'codex-job-demo-settings',startedAt:now-300000,percent:82,progressNote:'Reviewing focus order',access:'read',permission:'read-only'}),run('claude-job-demo-review','Review the settings changes',{agent:'claude',model:'sonnet',status:'done',finishedAt:now-300000,updatedAt:now-300000,startedAt:now-1100000,percent:undefined,etaAt:undefined,progressNote:'',access:'read',permission:'read-only'})];
const messages = [{id:'demo-message-1',from_name:'codex-showcase',from_agent:'codex',to_target:'claude-showcase',recipients:'claude-showcase',body:'The settings review is ready. Keyboard navigation is covered and the docs are updated.',created_at:now-180000},{id:'demo-message-2',from_name:'claude-showcase',from_agent:'claude',to_target:'codex-showcase',recipients:'codex-showcase',body:'Thanks. Please check the final focus order while I finish the release notes.',created_at:now-90000}];
const chat = {items:[{id:'prompt',kind:'user',at:now-660000,text:'Polish the settings page, keep the existing layout, and verify keyboard navigation. Ask before changing the default shortcuts.'},{id:'answer',kind:'assistant',at:now-640000,text:'I have checked the current settings and split out a focused keyboard review. The new controls follow the existing blue palette and preserve the current defaults.'},{id:'tool',kind:'tool',at:now-530000,tool:'shell',summary:'npm run typecheck — passed'},{id:'progress',kind:'assistant',at:now-60000,text:'The settings changes are ready. Focus order and accessible labels are checked; I am reviewing the last interaction before reporting the result.'}],next:null};
const network = {enabled:true,identity:{id:'demo-desktop',name:'demo-desktop'},config:{enabled:true,name:'demo-desktop',bind:'0.0.0.0',port:48148,discovery:true},port:48148,addresses:['192.0.2.10'],paired:[{id:'demo-laptop',name:'demo-laptop',connected:true,fingerprint:'abcdef0123456789',health:{lastVerifiedAt:now-30000,roundTripMs:12}}],discovered:[{id:'demo-studio',name:'demo-studio',host:'192.0.2.30',port:48148,seenAt:now-15000}]};
const question = {id:'demo-owner-question',kind:'question',title:'Choose a settings shortcut',context:'Which shortcut should open the quick settings panel?',topic:'settings-shortcut',options:[{id:'keep',label:'Keep the current shortcut',consequence:'Preserves the shortcuts people already use.',recommended:true},{id:'change',label:'Use Ctrl+Shift+P',consequence:'Adds a familiar quick-panel shortcut.',recommended:false}],askedAt:now-120000,status:'open',project:workspace,affectedProjects:[workspace],blocking:false,blocks:'',meanwhile:'Finish accessible labels and the keyboard navigation review.',links:[],askers:[{session:'claude-showcase',sessionId:'demo-session-claude',agent:'claude',main:'claude-showcase'}],deliveries:[]};
const fixture = {version,brokerPid:4242,peers,runs,runsNext:null,runsTotal:runs.length,jobs:Object.fromEntries(runs.map(r=>[r.job,{next:{},projectRoot:workspace}])),messages};
await writeFile(join(bridgeHome,'synthetic-fixture.json'),JSON.stringify({fixture,network,question,chat},null,2));
const seen = new Set();
const server = createServer(async (req,res) => {
  const url = new URL(req.url,'http://127.0.0.1');
  seen.add(url.pathname);
  if (url.pathname.startsWith('/agent-bridge/')) {
    const relative = decodeURIComponent(url.pathname.slice('/agent-bridge/'.length));
    const file = resolve(siteDirectory, relative + (url.pathname.endsWith('/') ? 'index.html' : ''));
    if (!file.startsWith(siteDirectory + sep)) {res.writeHead(403);res.end();return;}
    const types = {'.html':'text/html','.css':'text/css','.js':'application/javascript','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.json':'application/json','.wasm':'application/wasm'};
    try {res.setHeader('Content-Type',types[extname(file)] || 'application/octet-stream');res.end(await readFile(file));}
    catch {res.writeHead(404);res.end();}
    return;
  }
  if (url.pathname === '/') {res.setHeader('Content-Type','text/html');res.end(UI_PAGE);return;}
  let body = {};
  if(url.pathname === '/api/state') body = fixture;
  else if(url.pathname === '/api/network') body = network;
  else if(url.pathname === '/api/network/firewall') body = {status:{state:'allowed',detail:'Demo private network'},plan:{platform:'win32',commands:[],explanation:''}};
  else if(url.pathname === '/api/approvals') body = {approvals:[question],questionHistory:[]};
  else if(url.pathname === '/api/dashboard/heartbeat') body = {settings:{sound:false,toast:false,reminderMinutes:15},alerts:[]};
  else if(url.pathname === '/api/questions/settings') body = {sound:false,toast:false,reminderMinutes:15};
  else if(url.pathname === '/api/questions' || url.pathname === '/api/owner-questions') body = {questions:[question]};
  else if(url.pathname === '/api/usage') body = {reports:[]};
  else if(url.pathname === '/api/models') body = {reports:[]};
  else if(url.pathname === '/api/transfers') body = {transfers:[]};
  else if(url.pathname === '/api/decisions') body = {decisions:[]};
  else if(url.pathname === '/api/job-outcomes') body = {outcomes:{}};
  else if(url.pathname.endsWith('/subagents')) body = {subagents:[]};
  else if(url.pathname.endsWith('/chat')) body = chat;
  else if(url.pathname === '/api/search') body = {hits:[{id:'demo-hit-1',kind:'decision',agent:'claude',at:now-600000,snippet:'Settings: preserve the current shortcuts and use the same blue palette across the dashboard.'},{id:'demo-hit-2',kind:'run',agent:'codex',job:'codex-job-demo-settings',at:now-300000,snippet:'Settings polish: keyboard focus order, accessible labels and the owner-message composer are verified.'},{id:'demo-hit-3',kind:'message',agent:'codex',at:now-90000,snippet:'The settings review is ready. Keyboard navigation is covered and the docs are updated.'}]};
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url = 'http://127.0.0.1:'+server.address().port;
const chrome = spawn(browser,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+join(demo,'browser'),'about:blank'],{cwd:demo,windowsHide:true,stdio:'ignore',env:{...process.env,AGENT_BRIDGE_HOME:bridgeHome}});
let socket;
try {
  let port;
  for(let n=0;n<100;n++) {try {port=Number((await readFile(join(demo,'browser/DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch {await new Promise(r=>setTimeout(r,100));}}
  if(!port) throw new Error('Browser DevTools did not become ready.');
  const tabs = await fetch('http://127.0.0.1:'+port+'/json').then(r=>r.json());
  socket = new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
  let id=0;const pending=new Map();
  const errors=[];
  socket.onmessage = event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text+': '+(m.params.exceptionDetails.exception?.description||''));};
  const call=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});socket.send(JSON.stringify({id:key,method,params}));});
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  await call('Runtime.enable');await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await call('Page.navigate',{url});
  for(let n=0;n<100;n++){if(await evaluate('document.querySelector("#status")?.textContent.includes("bridge running")'))break;await new Promise(r=>setTimeout(r,100));}
  if (!await evaluate('document.querySelector("#status")?.textContent.includes("bridge running")')) throw new Error('Synthetic dashboard did not become ready.');
  const shots = [['dashboard-overview-dark.png','#/','dark'],['dashboard-overview-light.png','#/','light'],['dashboard-session-dark.png','#/s/claude-showcase/~chat','dark'],['dashboard-session-light.png','#/s/claude-showcase/~chat','light'],['dashboard-waiting.png','#/approvals','dark'],['dashboard-network.png','#/network','light'],['dashboard-search.png','#/search','dark']];
  for(const [name,hash,theme] of shots){
    await evaluate(`document.querySelector('#theme button[data-theme="${theme}"]').click(); location.hash=${JSON.stringify(hash)}`);
    if(hash==='#/search') await evaluate('document.querySelector("#sq").value="settings";document.querySelector("#searchForm").requestSubmit()');
    await new Promise(r=>setTimeout(r,1000));
    const visible = await evaluate('document.body.innerText');
    if(/Users[\\/]|Development[\\/]/i.test(visible)) throw new Error('A non-demo path appeared in '+name);
    if(name==='dashboard-waiting.png' && !visible.includes(question.context)) throw new Error('Owner question did not render; update the synthetic API shape for this release.');
    const shot = await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile(join(demo,name),Buffer.from(shot.data,'base64'));
  }
  // Render the built documentation using the same isolated browser. Review files stay
  // in the temporary Git root, separate from the dashboard images published by the site.
  const reviews = [['docs-site-dark.png','/agent-bridge/','dark'],['docs-site-light.png','/agent-bridge/','light'],['docs-concepts.png','/agent-bridge/concepts/sessions/','dark']];
  for (const [name,path,theme] of reviews) {
    await call('Page.navigate',{url:url+path});
    for(let n=0;n<100;n++){if(await evaluate('document.querySelector("h1") && document.readyState === "complete"'))break;await new Promise(r=>setTimeout(r,100));}
    await evaluate(`localStorage.setItem('starlight-theme',${JSON.stringify(theme)});document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    await new Promise(r=>setTimeout(r,1000));
    const shot = await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile(join(demo,name),Buffer.from(shot.data,'base64'));
  }
  if(errors.length) throw new Error(errors.join('\n'));
  await writeFile(join(demo,'capture-evidence.json'),JSON.stringify({release,version,synthetic:true,requests:[...seen],shots:shots.map(s=>s[0])},null,2));
  await mkdir(output, {recursive:true});
  for(const [name] of shots) await copyFile(join(demo,name), join(output,name));
  await copyFile(join(demo,'capture-evidence.json'),join(output,'capture-evidence.json'));
  console.log('Synthetic runtime and private browser profile: '+demo);
  console.log('Review these captures before committing:\n'+shots.map(([name])=>join(output,name)).join('\n'));
  console.log('Capture evidence: '+join(output,'capture-evidence.json'));
  console.log('Rendered documentation review files:\n'+reviews.map(([name])=>join(demo,name)).join('\n'));
} finally {socket?.close();chrome.kill();await new Promise(r=>server.close(r));}
