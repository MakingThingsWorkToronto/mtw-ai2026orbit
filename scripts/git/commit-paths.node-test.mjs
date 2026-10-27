import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { commitPaths } from './commit-paths.mjs';

const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const ok = () => ({ ok: true, output: '' });

function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-paths-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  const put = (rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
  put('shared.md', 'line one\nline two\n');
  put('gone.md', 'old\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  return { root, put };
}

test('commits only the given paths; a peer\'s staged file stays staged and uncommitted', (t) => {
  const { root, put } = repo(t);
  put('mine.txt', 'mine\n');
  put('peer.txt', 'peer\n');
  git(root, 'add', 'peer.txt');
  fs.rmSync(path.join(root, 'gone.md'));
  const r = commitPaths({ root, paths: ['mine.txt', 'gone.md'], message: 'mine', check: ok });
  assert.deepEqual(git(root, 'show', '--name-status', '--format=', 'HEAD').split('\n').sort(), ['A\tmine.txt', 'D\tgone.md']);
  assert.equal(r.attempts, 1);
  assert.match(git(root, 'status', '--porcelain'), /^A  peer\.txt$/m);
  assert.doesNotMatch(git(root, 'status', '--porcelain'), /mine\.txt|gone\.md/);
});

test('a hunk-only blob commits your change while a peer\'s edit to the same file stays in the working tree', (t) => {
  const { root, put } = repo(t);
  put('shared.md', 'line one PEER\nline two\nline three MINE\n');
  const blob = path.join(root, '..', `blob-${path.basename(root)}.md`);
  fs.writeFileSync(blob, 'line one\nline two\nline three MINE\n');
  t.after(() => fs.rmSync(blob, { force: true }));
  commitPaths({ root, blobs: [{ path: 'shared.md', file: blob }], message: 'hunk', check: ok });
  assert.equal(git(root, 'show', 'HEAD:shared.md'), 'line one\nline two\nline three MINE');
  assert.match(fs.readFileSync(path.join(root, 'shared.md'), 'utf8'), /PEER/);
});

test('when another session commits during the check, it rebuilds on the new HEAD instead of reverting them', (t) => {
  const { root, put } = repo(t);
  put('mine.txt', 'mine\n');
  let moved = false;
  const r = commitPaths({
    root, paths: ['mine.txt'], message: 'mine', check: ok,
    beforeSwap: () => {
      if (moved) return;
      moved = true;
      put('peer.txt', 'peer\n'); // the peer commits with its own private index
      const idx = path.join(root, '..', `peer-index-${path.basename(root)}`);
      const env = { ...process.env, GIT_INDEX_FILE: idx };
      spawnSync('git', ['read-tree', 'HEAD'], { cwd: root, env });
      spawnSync('git', ['add', 'peer.txt'], { cwd: root, env });
      const tree = spawnSync('git', ['write-tree'], { cwd: root, env, encoding: 'utf8' }).stdout.trim();
      const head = git(root, 'rev-parse', 'HEAD');
      const c = spawnSync('git', ['commit-tree', tree, '-p', head, '-m', 'peer'], { cwd: root, encoding: 'utf8' }).stdout.trim();
      git(root, 'update-ref', 'HEAD', c, head);
      fs.rmSync(idx, { force: true });
    },
  });
  assert.equal(r.attempts, 2);
  assert.equal(git(root, 'log', '--format=%s', '-3'), 'mine\npeer\nbase');
  assert.equal(git(root, 'show', 'HEAD:peer.txt'), 'peer');
});

test('syncs the shared index for thousands of paths (no command-line overflow)', (t) => {
  const { root, put } = repo(t);
  const many = Array.from({ length: 3000 }, (_, i) => `many/some-long-directory-name-to-fill-the-line/file-${i}.txt`);
  for (const p of many) put(p, `${p}\n`);
  git(root, 'add', 'many');
  git(root, 'commit', '-q', '-m', 'seed');
  for (const p of many) fs.rmSync(path.join(root, p));
  commitPaths({ root, paths: many, message: 'many', check: ok });
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('a refused check commits nothing', (t) => {
  const { root, put } = repo(t);
  put('mine.txt', 'mine\n');
  const before = git(root, 'rev-parse', 'HEAD');
  assert.throws(() => commitPaths({ root, paths: ['mine.txt'], message: 'x', check: () => ({ ok: false, output: 'nope' }) }), /refused/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), before);
});
