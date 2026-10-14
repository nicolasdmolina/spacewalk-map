// The rules behind "safe to delete". A wrong rule here tells someone to delete
// something they need, so each one is pinned down, including the near misses.

import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, KINDS } from '../server/kinds.mjs';

// up is the node's name, then its parent's, grandparent's and great-grandparent's.
const dir = (up, { depth = 5, siblings = [], children = [] } = {}) =>
  classify(true, up, depth, (n) => siblings.includes(n), (n) => children.includes(n));
const file = (name) => classify(false, [name], 5, () => false, () => false);

test('every kind a rule can return has a label, a tone and a blurb', () => {
  for (const [key, kind] of Object.entries(KINDS)) {
    assert.ok(kind.label, `${key} label`);
    assert.ok(['reclaim', 'review', 'neutral'].includes(kind.tone), `${key} tone`);
    assert.ok(kind.blurb, `${key} blurb`);
  }
});

test('node_modules is safe to delete, unless it is a global install or nested in a package', () => {
  assert.equal(dir(['node_modules', 'app', 'code']), 'node_modules');
  assert.equal(dir(['node_modules', 'lib', 'node']), null);
  assert.equal(dir(['node_modules', 'react', 'node_modules']), null);
});

test('dist and build only count as build output next to node_modules', () => {
  assert.equal(dir(['dist', 'app'], { siblings: ['node_modules'] }), 'build');
  assert.equal(dir(['dist', 'app']), null);
  assert.equal(dir(['build', 'app'], { siblings: ['node_modules'] }), 'build');
});

test('a Rust target folder needs a debug or release folder inside', () => {
  assert.equal(dir(['target', 'crate'], { children: ['debug'] }), 'build');
  assert.equal(dir(['target', 'crate']), null);
});

test('a Python environment needs a lib folder inside', () => {
  assert.equal(dir(['.venv', 'proj'], { children: ['lib'] }), 'venv');
  assert.equal(dir(['.venv', 'proj']), null);
  assert.equal(dir(['venv', 'proj']), null);
});

test('caches are found by name and by place', () => {
  assert.equal(dir(['Caches', 'Library', 'alex']), 'cache');
  assert.equal(dir(['.npm', 'alex']), 'cache');
  assert.equal(dir(['mod', 'pkg', 'go']), 'cache');
  assert.equal(dir(['registry', '.cargo']), 'cache');
  assert.equal(dir(['registry', 'project']), null);
});

test('per-user temporary folders are split into temp (T) and cache (C)', () => {
  assert.equal(dir(['T', 'abc123', 'xy', 'folders']), 'temp');
  assert.equal(dir(['C', 'abc123', 'xy', 'folders']), 'cache');
  assert.equal(dir(['T', 'abc123', 'xyz', 'folders']), null);
  assert.equal(dir(['T', 'abc123', 'xy', 'other']), null);
});

test('a folder named tmp only counts as /private/tmp, two levels below the root', () => {
  assert.equal(dir(['tmp', 'private'], { depth: 2 }), 'temp');
  assert.equal(dir(['tmp', 'private'], { depth: 5 }), null);
  assert.equal(dir(['tmp', 'project'], { depth: 2 }), null);
});

test('Xcode build data is told apart from other build folders', () => {
  assert.equal(dir(['DerivedData', 'Xcode', 'Developer']), 'xcode');
  assert.equal(dir(['DerivedData', 'project']), 'build');
});

test('review kinds are never marked safe to delete', () => {
  assert.equal(KINDS[dir(['CoreSimulator', 'Developer'])].tone, 'review');
  assert.equal(KINDS[dir(['avd', '.android'])].tone, 'review');
  assert.equal(KINDS[dir(['Backup', 'MobileSync'])].tone, 'review');
  assert.equal(KINDS[dir(['Photos.photoslibrary', 'Pictures'])].tone, 'review');
  assert.equal(KINDS[file('llama.gguf')].tone, 'review');
});

test('apps and git history are context, not suggestions', () => {
  assert.equal(KINDS[dir(['Safari.app', 'Applications'])].tone, 'neutral');
  assert.equal(KINDS[dir(['.git', 'repo'])].tone, 'neutral');
});

test('worktrees are only recognised in known agent folders', () => {
  assert.equal(dir(['worktrees', '.claude']), 'worktree');
  assert.equal(dir(['worktrees', '.codex']), 'worktree');
  assert.equal(dir(['worktrees', 'project']), null);
  assert.equal(dir(['worktree-0123abcd', 'x']), 'worktree');
});

test('Downloads only counts inside a user folder', () => {
  assert.equal(dir(['Downloads', 'alex', 'Users']), 'downloads');
  assert.equal(dir(['Downloads', 'project', 'code']), null);
});

test('files are judged by extension', () => {
  assert.equal(file('Setup.DMG'), 'installer');
  assert.equal(file('server.log'), 'logs');
  assert.equal(file('backup.tar'), 'archive');
  assert.equal(file('Docker.raw'), 'vm');
  assert.equal(file('movie.mov'), 'media');
  assert.equal(file('swapfile0'), 'swap');
  assert.equal(file('notes.txt'), null);
  assert.equal(file('.log'), null); // a dotfile is not a log
});
