// Fake host around the official stable MSP 1.4.7 conformance transcript shapes.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const corpus = (name) => fs.readFileSync(path.join(__dirname, name + '.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(JSON.parse(line).raw));
const text = corpus('text-run-single-turn');
const approval = corpus('approval-deny-round-trip').find((m) => m.method === 'approval/request');
const failure = corpus('provider-failure-turn').find((m) => m.method === 'turn/completed');
const cancelled = corpus('cancel-mid-turn').find((m) => m.method === 'turn/completed');
let sid = '0198f0aa-1111-7000-8000-0000000000aa', tid, initialized = false, tool;
const mode = process.env.MSP_TEST_MODE || 'finish';
const write = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const reply = (m, result) => write({ id: m.id, result });
const notify = (method, params) => write({ method, params: { sessionId: sid, viewCursor: 'opaque-cursor', ...params } });
const resultTemplate = (method) => text.find((m, i) => i > 0 && m.result && text[i - 1].method === method)?.result;
const sessionTemplate = text.find((m) => m.result?.session)?.result.session;
const agentTemplate = text.find((m) => m.method === 'item/completed' && m.params.item.kind === 'agentMessage').params.item;
const toolTemplate = corpus('cancel-mid-turn').find((m) => m.method === 'item/started' && m.params.item.kind === 'toolCall').params.item;
const finish = (terminal = 'completed') => {
  notify('item/completed', { item: { ...agentTemplate, turnId: tid, text: 'Completed native turn', revision: 2 } });
  if (mode === 'early') notify('item/completed', { item: { ...agentTemplate, turnId: tid, text: 'stale duplicate', revision: 1 } });
  notify('turn/completed', { ...text.find((m) => m.method === 'turn/completed').params, sessionId: sid, turnId: tid, terminal });
};
if (process.env.MSP_TEST_PID) fs.writeFileSync(process.env.MSP_TEST_PID, String(process.pid));
if (mode === 'stubborn') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (process.env.MSP_TEST_LOG) fs.appendFileSync(process.env.MSP_TEST_LOG, line + '\n');
  if (m.jsonrpc !== '2.0') throw new Error('missing JSON-RPC 2.0');
  if (m.method === 'initialized') { initialized = true; return; }
  if (!m.method) return;
  if (m.method !== 'initialize' && !initialized) throw new Error('missing initialized notification');
  if (!['initialize', 'hook/list', 'session/read', 'model/list', 'usage/read'].includes(m.method) && !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(m.params.commandId)) throw new Error('commandId is not UUIDv7');
  if (process.env.MSP_TEST_UNSUPPORTED === m.method) return write({ id: m.id, error: { code: -32601, message: 'Method not found' } });
  if (process.env.MSP_TEST_HANG === m.method) return;
  if (m.method === 'initialize') return reply(m, { ...text[1].result, grantedCapabilities: process.env.MSP_TEST_NO_MCP ? [] : ['sessionMcp'] });
  if (m.method === 'session/start' || m.method === 'session/resume') {
    sid = m.params.sessionId || sid;
    return reply(m, { session: { ...sessionTemplate, sessionId: sid, modelId: 'effective-native-model', ...(m.params.permissionProfile && !process.env.MSP_TEST_PROFILE_READ ? { permissionState: { profileId: process.env.MSP_TEST_PROFILE || m.params.permissionProfile } } : {}), approvalMode: { mode: m.params.approvalMode || 'allowAll', source: 'startup', lastCommandId: null } }, viewCursor: 'opaque-cursor', ...(m.method === 'session/resume' ? { history: { mode: 'none', items: [], snapshot: null }, pendingRequests: [] } : {}) });
  }
  if (m.method === 'session/read') return reply(m, { session: { ...sessionTemplate, sessionId: sid, ...(process.env.MSP_TEST_PROFILE ? { permissionState: { profileId: process.env.MSP_TEST_PROFILE } } : {}) }, history: { mode: 'none', items: [], snapshot: null }, viewCursor: 'opaque-cursor', pendingRequests: [] });
  if (m.method === 'hook/list') return reply(m, { hooks: JSON.parse(process.env.MSP_TEST_HOOKS || '[{"enabled":true,"event":"preToolUse","handlerKind":"plugin","key":"agent-bridge:PreToolUse:0"}]') });
  if (m.method === 'session/setApprovalMode') return reply(m, { commandId: m.params.commandId, status: 'accepted', applyOutcome: 'completed', effectiveMode: { mode: process.env.MSP_TEST_APPROVAL_MODE || m.params.mode, source: 'approvalReconfigure', lastCommandId: m.params.commandId } });
  if (m.method === 'model/list') return reply(m, text.find((m) => m.result?.models).result);
  if (m.method === 'usage/read') return reply(m, {});
  if (m.method === 'turn/start') {
    tid = m.params.commandId;
    const ack = { commandId: process.env.MSP_TEST_BAD_ACK ? 'wrong-command-id' : m.params.commandId, status: 'accepted', turnId: tid, startedNewTurn: mode !== 'queued', disposition: mode === 'queued' ? 'queued' : 'started' };
    if (mode === 'early') { finish(); reply(m, ack); return; }
    reply(m, ack);
    notify('turn/started', { turnId: tid, commandId: m.params.commandId });
    if (mode === 'crash') { process.stderr.write('native host crash evidence'); process.exit(3); }
    if (mode === 'gap') return notify('view/gap', { after: 'v1', next: 'v2' });
    if (mode === 'malformed') return process.stdout.write('broken json\n');
    if (mode === 'failure') return notify('turn/completed', { ...failure.params, sessionId: sid, turnId: tid });
    if (mode === 'foreign') { notify('turn/completed', { turnId: 'other-turn', terminal: 'failed' }); notify('item/completed', { sessionId: 'other-session', item: { ...agentTemplate, turnId: tid, text: 'foreign' } }); }
    if (mode === 'approval') {
      const params = { ...approval.params, sessionId: sid, turnId: tid, subject: process.env.MSP_TEST_SUBJECT ? JSON.parse(process.env.MSP_TEST_SUBJECT) : approval.params.subject, ...(process.env.MSP_TEST_NO_CHOICES ? { availableChoices: [] } : {}) };
      write({ ...approval, id: 1000, params });
      if (process.env.MSP_TEST_DUPLICATE) write({ ...approval, id: 1001, params });
      return;
    }
    if (mode === 'hold' || mode === 'stubborn' || mode === 'cancel' || mode === 'orphan') {
      notify('item/started', { item: { ...toolTemplate, turnId: tid } });
      if ((mode === 'cancel' || mode === 'orphan') && process.env.MSP_TEST_TOOL_PID) {
        tool = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
        fs.writeFileSync(process.env.MSP_TEST_TOOL_PID, String(tool.pid));
      }
      return;
    }
    return setTimeout(finish, 10);
  }
  if (m.method === 'turn/steer') {
    reply(m, { commandId: m.params.commandId, status: 'accepted', turnId: tid });
    return finish();
  }
  if (m.method === 'turn/cancel') {
    if (mode === 'stubborn') return;
    if (mode !== 'orphan') tool?.kill();
    reply(m, { commandId: m.params.commandId, status: 'accepted', turnId: tid });
    return notify('turn/completed', { ...cancelled.params, sessionId: sid, turnId: tid });
  }
  if (m.method === 'approval/decide') {
    reply(m, { commandId: m.params.commandId, status: 'accepted', approvalId: m.params.approvalId, terminal: true });
    return finish();
  }
  reply(m, { commandId: m.params.commandId, status: 'accepted' });
});
process.stdin.on('end', () => { if (mode !== 'stubborn') process.exit(0); });
