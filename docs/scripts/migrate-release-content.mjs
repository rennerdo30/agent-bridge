// Refresh canonical Markdown after rebasing onto a release whose docs/*.md
// predate the site migration. Read the tagged Git tree, never another checkout.
// cd docs && node scripts/migrate-release-content.mjs v0.30.0
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { posix, resolve } from 'node:path';

const revision = process.argv[2] || 'v0.30.0';
const repository = resolve(import.meta.dirname, '../..');
const paths = execFileSync('git', ['ls-tree','-r','--name-only',revision,'docs'], {cwd:repository,encoding:'utf8'}).trim().split('\n').filter(p => /^docs\/[^/]+\.md$/.test(p));
const routes = new Map(paths.map(p => {
  const name = p.slice('docs/'.length, -3);
  return [name, name === 'owner-questions' ? 'concepts/owner-questions' : name];
}));
let count = 0;
for (const file of paths) {
  const name = file.slice('docs/'.length,-3), slug = routes.get(name);
  const raw = execFileSync('git',['show',`${revision}:${file}`],{cwd:repository,encoding:'utf8'});
  if (raw.includes('This page has moved to the [documentation site]')) continue;
  const title = raw.match(/^# (.+)$/m)?.[1] || name.replaceAll('-',' ');
  let body = raw.replace(/^# .+\r?\n/, '').trim()
    .replace(/C:[\\/]Users[\\/][^\\/]+[\\/]AppData[\\/]Local/gi, '%LOCALAPPDATA%')
    .replace(/desktop-pc\\[a-z]+/gi, 'demo-pc\\demo-user');
  body = body.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (full,label,url) => {
    const [path,anchor] = url.split('#');
    if (path.startsWith('http:') || path.startsWith('https:') || !path) return full;
    const targetName = posix.basename(path,'.md');
    if (path.endsWith('.md') && routes.has(targetName))
      return `[${label}](${posix.relative(slug,routes.get(targetName))}/${anchor ? '#'+anchor : ''})`;
    if (path === '../README.md') return `[${label}](${posix.relative(slug,'.')}/)`;
    if (path.endsWith('.md') || path.startsWith('../src/')) return `[${label}](https://github.com/rennerdo30/agent-bridge/blob/main/${path.replace(/^\.\.\//,'')})`;
    return full;
  });
  const output = `src/content/docs/${slug}.md`;
  if (name === 'data-retention') {
    try {
      const previous = await readFile(output,'utf8');
      const marker = '\n## Retention configuration and upgrade behavior';
      const at = previous.indexOf(marker);
      if (at >= 0) body += '\n' + previous.slice(at).trimEnd();
    } catch {}
  }
  await mkdir(posix.dirname(output), {recursive:true});
  await writeFile(output, `---\ntitle: ${JSON.stringify(title)}\nslug: ${slug}\n---\n\n${body}\n`);
  await writeFile(`../${file}`, `# ${title}\n\nThis page has moved to the [documentation site](https://rennerdo30.github.io/agent-bridge/${slug}/).\n\nThe maintained source is [src/content/docs/${slug}.md](src/content/docs/${slug}.md).\n`);
  count++;
}
console.log(`Migrated ${count} release documents from ${revision}`);
