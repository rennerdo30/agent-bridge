import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { MessageStore } from '../src/core/store.js';
import { nullLogger } from '../src/core/logger.js';
import { conversationProject, projectDatabasePath, syncProjectMirror } from '../src/core/project-store.js';
import { foreignMirrorRecord, readConversation } from '../src/core/conversations.js';
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ab-mirror-home-')); });
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
it('keeps a nested foreign home out of a main repository even after worktree canonicalization', () => {
  const main = join(root, 'main'), wt = join(root, 'worktree'); mkdirSync(main);
  execFileSync('git', ['init', main], { stdio: 'ignore' });
  execFileSync('git', ['-C', main, 'worktree', 'add', '--orphan', '-b', 'fixture', wt], { stdio: 'ignore' });
  const home = join(wt, '.agent-bridge-test', 'fixture', 'home'); mkdirSync(home, { recursive: true });
  const project = conversationProject(home), exclude = readFileSync(join(main, '.git', 'info', 'exclude'));
  expect(project).toBe(conversationProject(main));
  const store = new MessageStore(join(home, 'bridge.db'), nullLogger), db = store.history.database;
  try {
    db.prepare("INSERT INTO conversations(id,agent,session,project) VALUES('fixture','codex','fake',?)").run(project);
    db.prepare("INSERT INTO conversation_records VALUES(1,'fixture',0,0,'fixture',1,?,'fixture',NULL)").run(Buffer.from('fixture'));
    expect(syncProjectMirror(db, project, home)).toBe(1);
    expect(existsSync(projectDatabasePath(project, home))).toBe(true);
    expect(existsSync(join(main, '.agent-bridge'))).toBe(false);
    expect(existsSync(join(wt, '.agent-bridge'))).toBe(false);
    expect(readFileSync(join(main, '.git', 'info', 'exclude'))).toEqual(exclude);
    const mirror = new DatabaseSync(projectDatabasePath(project, home), { readOnly: true });
    try { expect(readConversation(mirror, { id: 'fixture' }).records[0]?.text).toBe('fixture'); } finally { mirror.close(); }
  } finally { store.close(); }
});
it('marks previously mixed fixture snapshots without removing or modifying their bytes', () => {
  const store = new MessageStore(join(root, 'bridge.db'), nullLogger), db = store.history.database;
  const source = 'job-snapshot:codex-job-fixture:hash';
  const text = JSON.stringify({ workdir: join(root, '.agent-bridge-test', 'idle-before-main', 'home'), prompt: 'fixture' });
  try {
    db.exec("INSERT INTO conversations(id,agent,session) VALUES('fixture','codex','fake')");
    db.prepare("INSERT INTO conversation_records VALUES(1,?,0,0,'fixture',1,?,?,NULL)").run(source, Buffer.from(text), text);
    const page = readConversation(db, { id: 'fixture' });
    expect(page.records[0]).toMatchObject({ foreignHome: true, text, raw: Buffer.from(text).toString('base64') });
    expect(db.prepare('SELECT raw FROM conversation_records').get()!.raw).toEqual(new Uint8Array(Buffer.from(text)));
    expect(foreignMirrorRecord('owner-transcript', text)).toBe(false);
    expect(foreignMirrorRecord(source, JSON.stringify({ workdir: root, prompt: text }))).toBe(false);
  } finally { store.close(); }
});
