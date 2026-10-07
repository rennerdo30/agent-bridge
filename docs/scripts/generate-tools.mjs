// Regenerate after product changes: cd docs && node scripts/generate-tools.mjs.
import { parse } from '@babel/parser';
import { readFile, writeFile } from 'node:fs/promises';

const source = await readFile('../src/mcp/server.ts', 'utf8');
const file = parse(source, {sourceType:'module', plugins:['typescript']});
const text = n => source.slice(n.start, n.end);
function walk(node, visit) {
  visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (['loc','start','end','extra'].includes(key)) continue;
    if (Array.isArray(child)) child.forEach(n => {if(n?.type) walk(n, visit)});
    else if(child?.type) walk(child, visit);
  }
}
const rows = [];
const agents = ['claude', 'codex', 'opencode', 'antigravity'];

function value(node, agent = '') {
  if (!node) return '';
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "BinaryExpression" && node.operator === "+")
    return value(node.left, agent) + value(node.right, agent);
  if (node.type === "TemplateLiteral") {
    return node.quasis.map((part, i) => {
      if (!node.expressions[i]) return part.value.cooked;
      const expression = text(node.expressions[i]);
      const replacement = expression === 'target' ? agent
        : expression === 'profile.title' ? ({claude:'Claude Code', codex:'Codex', opencode:'opencode', antigravity:'Google Antigravity CLI'}[agent])
        : expression === 'parent.name' ? 'your supervisor' : expression;
      return part.value.cooked + replacement;
    }).join('');
  }
  return '';
}

function visit(node) {
  if (node.type === 'CallExpression' && text(node.callee) === 'register') {
    const [name, config] = node.arguments;
    if (!config || config.type !== 'ObjectExpression') return;
    const properties = Object.fromEntries(config.properties.filter(p => p.type === 'ObjectProperty').map(p => [text(p.key), p.value]));
    const names = name.type === 'StringLiteral' ? [[name.value, '']]
      : text(name) === 'askName' ? agents.map(a => [`ask_${a}`, a])
      : text(name) === 'spawnName' ? agents.map(a => [`spawn_${a}`, a]) : [];
    for (const [tool, agent] of names) {
      const schema = properties.inputSchema;
      const fields = schema && schema.type === 'ObjectExpression'
        ? schema.properties.filter(p => p.type === 'ObjectProperty').map(p => {
          const shape = text(p.value).replace(/\s+/g, ' ');
          return { name:text(p.key), optional:shape.includes('.optional(') || shape === 'nativeSubagentsSchema', shape };
        }) : [];
      let description = value(properties.description, agent);
      if (agent) description += ' Access defaults to read. Supported access, sandbox and model options depend on the target CLI; see the delegated access guide.';
      rows.push({tool, description, fields, sharedSchema: schema && schema.type !== 'ObjectExpression' ? text(schema) : ''});
    }
  }

}
walk(file, visit);
const escape = s => s.replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('BROADCAST', '*').replaceAll('cfg.maxJobs', 'the shared job limit').replaceAll('cfg.maxHops', 'the configured hop limit');
let page = `---\ntitle: MCP tools reference\n---\n\nGenerated from [src/mcp/server.ts](https://github.com/rennerdo30/agent-bridge/blob/main/src/mcp/server.ts). Each registered tool has one row below. Availability depends on the calling agent, enabled targets and whether the caller is a delegated job. opencode prefixes tool names with \`bridge_\`.\n\nThe \`ask_*\` and \`spawn_*\` tools are expanded for each supported CLI; a session may offer only the other enabled targets. Delegated jobs receive a restricted tool set and explicit messaging grants. \`report_progress\` is for delegated jobs; \`hook_event\` is internal and must never be called by an agent.\n\n| Tool | Parameters | Behavior |\n| --- | --- | --- |\n`;
for (const r of rows) page += `| \`${r.tool}\` | ${r.tool === 'get_conversation' ? '`id`, `after?`, `limit?`' : /^(ask|spawn)_/.test(r.tool) ? '[Delegation options](#delegation-options)' : r.fields.map(f => '\`' + f.name + (f.optional ? '?' : '') + '\`').join(', ') || 'None'} | ${escape(r.description)} |\n`;
page += '\n## Delegation options\n\n';
page += 'Peer names default to `<agent>-<project folder>` (for example `codex-showcase`), or `<agent>-session` until the folder is known. An agent-kind address such as `codex` selects that local peer when unambiguous. Set `AGENT_BRIDGE_NAME` or `name` in the configuration to choose a peer name.\n\n';
page += '- `session_id` continues an earlier run; `cwd` selects its working folder.\n- `host` runs on a paired PC with separate remote-job permission.\n- `native_subagents` sets the Codex child-thread budget (default 6, range 0–32; 0 disables). This differs from bridge delegation depth and concurrency.\n- `send_to` grants messaging to exact local sessions or jobs outside the default sibling scope.\n- `timeout_sec` defaults to 60 minutes for `ask_*`; background jobs default to the 24-hour ceiling. A timeout reports the session ID so a caller can continue retained context.\n- Target options include Codex `sandbox` and `approvals_reviewer`, Claude `permission_mode`, opencode `auto_approve`, and Antigravity `terminal_sandbox` and `bypass_permissions`. Codex defaults to `auto_review`; `user` forwards eligible requests.\n\n';

// The source uses target-specific schemas. Preserve the exact current schema text
// so optional/default/enum bounds remain reviewable without guessing parameters.
const declarations = [];
function schemas(node) {
  if (node.type === 'VariableDeclarator' && node.init && /schema|common/i.test(text(node.id))) {
    const declaration = text(node);
    if (/access|prompt|session_id/.test(declaration) && declaration.length < 16000) declarations.push(declaration);
  }

}
walk(file, schemas);
page += 'Pass a prompt and a short title for a new job. Set `access` deliberately and use `worktree: true` for edits. `host` requires an absolute remote `cwd`; `send_to` grants are local-only. A continuation preserves saved settings unless explicitly overridden. See [delegation](../../concepts/delegation/), [access and approval forwarding](../../delegated-access/) and [remote jobs](../../remote-jobs/).\n\n';
for (const declaration of declarations) page += '```ts\n' + declaration + '\n```\n\n';
const targetSource = await readFile('../src/mcp/targets.ts', 'utf8');
const targetFile = parse(targetSource, {sourceType:'module', plugins:['typescript']});
walk(targetFile, node => {
  if (node.type === 'ObjectProperty' && node.key.type === 'Identifier' && node.key.name === 'schema')
    page += '```ts\n' + targetSource.slice(node.start, node.end) + '\n```\n\n';
});
page += '## Parameter schemas\n\nThe following source excerpts preserve bounds and defaults. A question mark in the table means the schema uses `.optional()`. Named shared schemas are defined in the product source.\n\n';
page += '### get_conversation\n\n`id` is a retained source ID from `search_history` (1–512 characters). `after` is an optional nonnegative integer cursor. `limit` is an optional integer from 1 to 100. Follow `next` until exhausted, grouping exact-byte chunks by source and generation. No model is called and no conversation is exported.\n\n';
for (const r of rows.filter(r => r.fields.length)) {
  page += `### ${r.tool}\n\n\`\`\`ts\n${r.fields.map(f => `${f.name}: ${f.shape}`).join('\n')}\n\`\`\`\n\n`;
}
await writeFile('src/content/docs/reference/tools.md', page.trimEnd() + '\n');
console.log(`Documented ${rows.length} tools from src/mcp/server.ts`);
