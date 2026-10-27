#!/usr/bin/env node
// commit-paths — commit exact paths safely in a repo where several sessions share one working tree and one index.
//
// Why: `.git/index` is shared, so a bare `git commit` takes other sessions' staged files; `git commit -- <paths>`
// commits whole working-tree files, so it cannot carry only your hunk of a file another session is also editing; and
// other sessions commit while the (slow) pre-commit check runs, so a commit built on an older HEAD either fails to lock
// HEAD or silently reverts their work. This script:
//   1. builds a PRIVATE index from the current HEAD and stages only your paths (deletions included), plus optional
//      hunk-only blobs (`--blob <path>=<file holding HEAD's text plus only your change>`);
//   2. runs the repo's pre-commit check (scripts/hooks/pre-commit.mjs) against that private index — never skipped;
//   3. writes the commit with `git commit-tree` and moves HEAD only if it has not moved (`git update-ref HEAD new old`);
//      if HEAD moved, it rebuilds on the new HEAD and retries, re-running the check when the new commits touch your paths;
//   4. syncs the shared index for your paths (`git reset -q -- <paths>`) so it cannot record your files as deleted;
//   5. with --push, pushes the branch.
//
// Usage (from the repo root):
//   node scripts/git/commit-paths.mjs -m "Subject" [-m "Body"] [-F msgfile] [--paths-from list.txt] [--blob p=file]... [--push] [-- <paths...>]
// Exit 0 on commit, 1 on a refused check or failure, 2 on usage errors.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_ATTEMPTS = 8;

function run(cmd, args, { root, env = {}, input } = {}) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', input, maxBuffer: 1 << 28, env: { ...process.env, ...env } });
  return { status: r.status ?? 1, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

function git(root, args, opts = {}) {
  const r = run('git', args, { root, ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r;
}

/**
 * Commit `paths` (and `blobs`: [{path, file}]) on top of HEAD without touching anyone else's staged work.
 * `check(env)` returns {ok, output} (default: the repo pre-commit hook). `beforeSwap` is a test seam.
 * Returns { commit, parent, attempts }.
 */
export function commitPaths({ root, paths = [], blobs = [], message, check, beforeSwap, log = () => {} }) {
  if (!message?.trim()) throw new Error('a commit message is required');
  if (!paths.length && !blobs.length) throw new Error('no paths given');
  const own = [...new Set([...paths, ...blobs.map((b) => b.path)])];
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'commit-paths-'));
  const index = path.join(tmp, 'index');
  const list = path.join(tmp, 'paths');
  const msg = path.join(tmp, 'message');
  writeFileSync(list, `${paths.join('\0')}\0`);
  writeFileSync(msg, message.endsWith('\n') ? message : `${message}\n`);
  const env = { GIT_INDEX_FILE: index };
  const runCheck =
    check ??
    ((e) => {
      const hook = path.join(root, 'scripts', 'hooks', 'pre-commit.mjs');
      if (!existsSync(hook)) return { ok: true, output: 'no pre-commit check in this repo' };
      const r = run('node', [hook], { root, env: e });
      return { ok: r.status === 0, output: [r.stdout, r.stderr].filter(Boolean).join('\n') };
    });
  try {
    let checkedOn = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const parent = git(root, ['rev-parse', '--verify', 'HEAD'], { allowFail: true }).stdout || null;
      rmSync(index, { force: true });
      git(root, parent ? ['read-tree', parent] : ['read-tree', '--empty'], { env });
      if (paths.length) git(root, ['add', '-A', '--pathspec-from-file', list, '--pathspec-file-nul'], { env });
      for (const b of blobs) {
        const blob = git(root, ['hash-object', '-w', b.file]).stdout;
        git(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${b.path}`], { env });
      }
      const staged = git(root, ['diff', '--cached', '--name-only', ...(parent ? [parent] : [])], { env }).stdout.split('\n').filter(Boolean);
      if (!staged.length) throw new Error('nothing to commit: the given paths match HEAD');
      // Re-run the check unless HEAD only moved in ways that touch none of our paths since it last passed.
      const touched = checkedOn ? git(root, ['diff', '--name-only', checkedOn, parent]).stdout.split('\n').filter(Boolean) : null;
      if (!checkedOn || touched.some((p) => own.includes(p))) {
        const c = runCheck(env);
        if (!c.ok) {
          const e = new Error(`pre-commit check refused the commit:\n${c.output}`);
          e.code = 'CHECK';
          throw e;
        }
        checkedOn = parent;
      }
      const tree = git(root, ['write-tree'], { env }).stdout;
      const commit = git(root, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-F', msg]).stdout;
      beforeSwap?.(attempt);
      const swap = git(root, ['update-ref', 'HEAD', commit, parent || '0'.repeat(commit.length)], { allowFail: true });
      if (swap.status === 0) {
        // Paths go through a file: thousands of paths overflow the Windows command line and the sync silently fails.
        writeFileSync(list, `${own.join('\0')}\0`);
        const sync = git(root, ['reset', '-q', '--pathspec-from-file', list, '--pathspec-file-nul'], { allowFail: true });
        if (sync.status !== 0) log(`committed, but the shared index sync failed; run: git reset -q -- <your paths>\n${sync.stderr}`);
        return { commit, parent, attempts: attempt, staged };
      }
      log(`HEAD moved during attempt ${attempt}; rebuilding on the new HEAD`);
    }
    throw new Error(`HEAD kept moving; gave up after ${MAX_ATTEMPTS} attempts`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const out = { messages: [], paths: [], blobs: [], push: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.paths.push(...argv.slice(i + 1)); break; }
    else if (a === '-m') out.messages.push(argv[++i]);
    else if (a === '-F') out.messages.push(readFileSync(argv[++i], 'utf8'));
    else if (a === '--paths-from') out.paths.push(...readFileSync(argv[++i], 'utf8').split(/\r?\n|\0/).filter(Boolean));
    else if (a === '--blob') { const [p, f] = argv[++i].split('='); out.blobs.push({ path: p, file: f }); }
    else if (a === '--push') out.push = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else out.paths.push(a);
  }
  return out;
}

const invokedDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const root = run('git', ['rev-parse', '--show-toplevel']).stdout;
  if (args.help || !root || !args.messages.length || (!args.paths.length && !args.blobs.length)) {
    process.stderr.write('Usage: node scripts/git/commit-paths.mjs -m "Subject" [-m "Body"] [-F msgfile] [--paths-from file] [--blob path=file]... [--push] [-- paths...]\n');
    process.exit(2);
  }
  try {
    const r = commitPaths({ root, paths: args.paths, blobs: args.blobs, message: args.messages.join('\n\n'), log: (s) => process.stderr.write(`${s}\n`) });
    process.stdout.write(`committed ${r.commit.slice(0, 8)} on ${(r.parent || 'root').slice(0, 8)} (${r.staged.length} path(s), attempt ${r.attempts})\n`);
    if (args.push) {
      const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { root }).stdout;
      const p = run('git', ['push', 'origin', branch], { root });
      process.stdout.write(`${p.stdout}${p.stderr ? `\n${p.stderr}` : ''}\n`);
      if (p.status !== 0) process.exit(1);
    }
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
