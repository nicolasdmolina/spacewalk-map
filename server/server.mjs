// Spacewalk's local server. It runs the scanner, keeps the latest snapshot
// in memory, and serves the map's API and web app. It listens on 127.0.0.1;
// --tailnet adds this Mac's Tailscale address, never any other. Read-only:
// the one thing it does to the Mac is ask Finder to reveal an item, and only
// for a browser on the Mac itself.

import http from 'node:http';
import os from 'node:os';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { KINDS, classify } from './kinds.mjs';
import { NF, Snapshot, readSnapshot } from './snapshot.mjs';
import { loadFirmlinks, readDisk } from './disk.mjs';

// ---------------------------------------------------------------- options

const USAGE = `usage: spacewalk [--port N] [--tailnet] [--host NAME]... [--no-open]
                 [--scan | --no-scan] [--snapshot FILE]

Maps what fills this Mac's disk and serves the map on http://127.0.0.1:4747.

  --port N         listen on port N instead of 4747
  --tailnet        also listen on this Mac's Tailscale address, so your other
                   devices on the tailnet can open the map
  --host NAME      another name this Mac answers to on the tailnet
  --no-open        don't open the map in the browser
  --scan           start a fresh scan right away
  --no-scan        show the last scan without starting a new one
                   (by default a scan starts when the last is 10 minutes old)
  --snapshot FILE  show this snapshot instead of the latest scan
`;

function usage(code) {
  (code ? process.stderr : process.stdout).write(USAGE);
  process.exit(code);
}

const opt = { port: 4747, tailnet: false, hosts: [], open: true, scan: 'auto', snapshot: null };
{
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = () => (i + 1 < args.length ? args[++i] : usage(64));
    if (a === '--port') opt.port = Number(value());
    else if (a === '--tailnet') opt.tailnet = true;
    else if (a === '--host') opt.hosts.push(value().toLowerCase());
    else if (a === '--no-open') opt.open = false;
    else if (a === '--scan') opt.scan = 'yes';
    else if (a === '--no-scan') opt.scan = 'no';
    else if (a === '--snapshot') opt.snapshot = resolve(value());
    else if (a === '-h' || a === '--help') usage(0);
    else usage(64);
  }
  if (!Number.isInteger(opt.port) || opt.port < 1 || opt.port > 65535) usage(64);
}

// ---------------------------------------------------------------- places

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCANNER = join(ROOT, 'scanner', 'spacewalk-scan');
const DIST = join(ROOT, 'ui', 'dist');
const HOME = os.homedir();
const CACHE = join(HOME, 'Library', 'Caches', 'Spacewalk');
const SUPPORT = join(HOME, 'Library', 'Application Support', 'Spacewalk');
const LATEST = join(CACHE, 'latest.spwk');
const LATEST_META = join(CACHE, 'latest.json');
const SKIP_FILE = join(CACHE, 'skip.json');
const JETTISON_FILE = join(SUPPORT, 'jettison.json');
const DATA = '/System/Volumes/Data';
// Left unopened in every scan: it has hung a listing on this Mac before.
const ALWAYS_SKIP = [join(HOME, 'Library', 'Group Containers', 'group.is.workflow.shortcuts')];
const SKIP_DAYS = 7; // a folder that stalled a scan is left alone this long
const AUTO_SCAN_AFTER = 10 * 60e3;

const firmlinks = loadFirmlinks();
const machine = os.hostname().replace(/\.local$/i, '');

function log(msg) {
  console.log(msg);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// The app Spacewalk was started from. macOS grants folder access to that
// app, so it is the one to give Full Disk Access to. Best effort.
function findLaunchingApp() {
  let pid = process.ppid;
  for (let k = 0; k < 16 && pid > 1; k++) {
    let line;
    try {
      line = execFileSync('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
    const m = /^(\d+)\s+(.*)$/.exec(line);
    if (!m) return null;
    const app = /^.*?\/([^/]+)\.app\//.exec(m[2]);
    if (app) return app[1];
    if (/(^|\/)tmux/.test(m[2])) return 'tmux';
    pid = Number(m[1]);
  }
  return null;
}
const launchedFrom = findLaunchingApp();

// ---------------------------------------------------------------- the disk

let live = { at: 0, disk: null, pending: null };

// The disk as it is now, at most 30 seconds old.
function liveDisk(fresh = false) {
  if (live.disk && !fresh && Date.now() - live.at < 30e3) return Promise.resolve(live.disk);
  live.pending ??= readDisk().then(
    (disk) => {
      live = { at: Date.now(), disk, pending: null };
      return disk;
    },
    (err) => {
      live.pending = null;
      throw err;
    },
  );
  return live.pending;
}

const VOLUME_NAMES = { System: 'macOS', Data: 'Data', VM: 'Swap', Preboot: 'Preboot', Recovery: 'Recovery', Update: 'Update' };
const VOLUME_PATHS = { Data: DATA, VM: '/System/Volumes/VM' };
const NOTES = {
  disk: 'The whole internal disk: every volume on it and the space still free.',
  System: 'The read-only volume macOS runs from. It is sealed, so nothing in it can be deleted.',
  Data: 'Everything that is not macOS itself: apps, your files, caches and system data.',
  VM: 'Memory macOS moved to disk. It shrinks on its own, and a restart clears it.',
  Preboot: 'What the Mac needs to start up, kept by macOS for each installed version.',
  Recovery: 'macOS Recovery, used to repair or reinstall macOS. Leave it alone.',
  Update: 'Space macOS uses while it installs updates.',
  volume: 'A volume on the internal disk.',
  free: 'Space left for new files.',
  overhead: 'Space APFS keeps for its own records.',
  hidden:
    "Space the Data volume reports as used that the scan could not see: data other apps keep private, folders macOS locks, and the file system's own records.",
  pending: 'Not counted yet. The scan is still working through it.',
};

// ---------------------------------------------------------------- snapshot

let snap = null; // the Snapshot on show
let snapDisk = null; // the disk as it was when that scan finished
let snapSource = null;

function load(file, meta) {
  const s = readSnapshot(file, firmlinks);
  snap = s;
  snapDisk = meta?.disk ?? null;
  snapSource = file;
  // Work these out now, so the first visit doesn't wait for them.
  setImmediate(() => {
    try {
      s.heat();
      s.insights();
      s.unreadable();
    } catch (err) {
      log(`Could not sum up the scan: ${err.message}`);
    }
  });
}

function diskModel() {
  return snapDisk ?? live.disk;
}

function rootFor(role) {
  const path = VOLUME_PATHS[role];
  if (!snap || !path) return -1;
  for (const r of snap.roots.values()) if (r.path === path) return r.index;
  return -1;
}

function volumeOfRoot(i) {
  const root = snap.roots.get(i);
  const role = root && Object.keys(VOLUME_PATHS).find((r) => VOLUME_PATHS[r] === root.path);
  return role ? diskModel()?.volumes.find((v) => v.role === role) : null;
}

function insertBySize(kids, node) {
  const at = kids.findIndex((k) => k.size < node.size);
  kids.splice(at < 0 ? kids.length : at, 0, node);
}

// A scanned volume, sized as macOS reports it. What the scan could not see
// becomes one more child, so the map adds up to the whole volume.
function dressVolume(node, v, gapNode) {
  node.name = VOLUME_NAMES[v.role] ?? v.name;
  node.volume = v.role;
  node.note = NOTES[v.role] ?? NOTES.volume;
  node.scanned = node.size;
  const gap = Math.round(v.used - node.size);
  if (gap > 0) {
    node.size = v.used;
    if (node.kids) insertBySize(node.kids, { ...gapNode, size: gap });
  }
  return node;
}

function volumeLeaf(v) {
  const role = v.role ?? 'volume';
  return {
    id: `vol:${v.role ?? v.dev}`,
    name: VOLUME_NAMES[role] ?? v.name,
    size: v.used,
    role: 'volume',
    volume: role,
    flags: 0,
    pending: role === 'Data',
  };
}

const HIDDEN = { id: 'hidden', name: 'Hidden from scan', role: 'hidden', flags: 0 };
const PENDING = { id: 'pending', name: 'Not scanned yet', role: 'pending', flags: 0 };

// The whole disk: its volumes, free space and APFS overhead. The Data
// volume comes from the snapshot, or from the scan while one is running.
function diskTree(model, depth, minSize) {
  const node = { id: 'disk', name: model.name, size: model.size, role: 'disk', flags: NF.DIR, open: true };
  if (depth <= 0) return node;
  const kids = model.volumes.map((v) => {
    const root = rootFor(v.role);
    if (root > 0) return dressVolume(snap.tree(root, depth - 1, minSize, null), v, HIDDEN);
    if (v.role === 'Data' && !snap && scan.live) return liveVolume(v);
    return volumeLeaf(v);
  });
  kids.sort((a, b) => b.size - a.size);
  if (model.overhead > 0)
    kids.push({ id: 'overhead', name: 'APFS overhead', size: model.overhead, role: 'overhead', flags: 0 });
  kids.push({ id: 'free', name: 'Free', size: model.free, role: 'free', flags: 0 });
  node.kids = kids;
  node.rc = kids.reduce((sum, k) => sum + (k.rc ?? 0), 0);
  node.rv = kids.reduce((sum, k) => sum + (k.rv ?? 0), 0);
  return node;
}

// The scanner's live tree (two levels below the volume) in the map's shape.
// Its heat (rc, rv) follows Snapshot.heat, from the levels the scanner sent.
function liveNode(n, up, depth, outer, outerTone = 0) {
  const isDir = (n.flags & NF.DIR) !== 0;
  const own = depth > 0 ? classify(isDir, [n.name, ...up].slice(0, 4), depth, () => false, () => false) : null;
  const kind = Snapshot.merge(outer, own);
  const t = kind && KINDS[kind].tone;
  const tone = t === 'reclaim' ? 2 : t === 'review' ? 1 : kind && KINDS[kind].whole ? 0 : outerTone;
  const node = { name: n.name, size: n.size, flags: n.flags };
  if (kind) node.kind = kind;
  let rc = 0,
    rv = 0,
    inner = 0;
  if (n.children) {
    node.kids = n.children.map((c) => liveNode(c, depth > 0 ? [n.name, ...up] : [], depth + 1, kind, tone));
    for (const k of node.kids) {
      rc += k.rc ?? 0;
      rv += k.rv ?? 0;
      inner += k.size;
    }
  }
  const rest = Math.max(0, n.size - inner);
  if (tone === 2) rc += rest;
  else if (tone === 1) rv += rest;
  if (rc) node.rc = rc;
  if (rv) node.rv = rv;
  return node;
}

function liveVolume(v) {
  const data = scan.live?.find((r) => r.name === 'Data');
  if (!data) return volumeLeaf(v);
  const node = liveNode(data, [], 0, null);
  Object.assign(node, { id: 'vol:Data', role: 'volume' });
  node.kids ??= [];
  dressVolume(node, v, PENDING);
  // The part still to scan stays at the end of the ring, where the map grows into it.
  const at = node.kids.findIndex((k) => k.id === 'pending');
  if (at >= 0) node.kids.push(...node.kids.splice(at, 1));
  return node;
}

function liveDiskTree() {
  const model = scan.model ?? live.disk;
  return model && scan.live ? { ...diskTree(model, 4, 0), live: true } : null;
}

// ---------------------------------------------------------------- scanning

const scan = {
  child: null,
  status: 'idle', // idle, scanning or finishing
  mode: null,
  startedAt: 0,
  out: null,
  model: null, // the disk when the scan started
  progress: null,
  live: null,
  done: null,
  stopping: false,
  error: null,
  stderr: '',
};

function skipList() {
  const now = Date.now();
  const kept = Object.entries(readJson(SKIP_FILE)?.paths ?? {})
    .filter(([, at]) => now - at < SKIP_DAYS * 864e5)
    .map(([path]) => path);
  return [...new Set([...ALWAYS_SKIP, ...kept])];
}

function rememberStalled(paths) {
  const now = Date.now();
  const before = readJson(SKIP_FILE)?.paths ?? {};
  const next = Object.fromEntries(Object.entries(before).filter(([, at]) => now - at < SKIP_DAYS * 864e5));
  for (const path of paths) next[path] = now;
  if (JSON.stringify(next) !== JSON.stringify(before)) writeJson(SKIP_FILE, { paths: next });
}

function removeQuietly(file) {
  try {
    rmSync(file, { force: true });
  } catch {
    // nothing to clean up
  }
}

function scanInfo() {
  return {
    status: scan.status,
    mode: scan.mode,
    startedAt: scan.startedAt || null,
    progress: scan.progress,
    error: scan.error,
    // What the last scan found, to tell how far along this one is.
    expected: snap ? { bytes: snap.header.bytes, files: snap.header.files, seconds: snap.header.elapsed } : null,
  };
}

function startScan(mode) {
  if (scan.child) throw httpError(409, 'A scan is already running.');
  if (!existsSync(SCANNER))
    throw httpError(500, 'The scanner is not built yet. Start Spacewalk with bin/spacewalk, which builds it.');
  mkdirSync(CACHE, { recursive: true });
  const out = join(CACHE, `scan-${Date.now()}.spwk`);
  const args = ['--out', out, '--protected', mode];
  for (const path of skipList()) args.push('--skip', path);
  args.push(`Data=${DATA}`);
  const child = spawn(SCANNER, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  Object.assign(scan, {
    child,
    status: 'scanning',
    mode,
    startedAt: Date.now(),
    out,
    model: null,
    progress: null,
    live: null,
    done: null,
    stopping: false,
    error: null,
    stderr: '',
  });
  liveDisk(true).then(
    (disk) => scan.child === child && (scan.model = disk),
    () => {},
  );
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      onScanEvent(child, event);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => (scan.stderr = (scan.stderr + chunk).slice(-2000)));
  child.on('error', (err) => scan.child === child && !scan.done && endScan(child, `The scanner could not start: ${err.message}`));
  child.on('close', (code, signal) => onScanExit(child, code, signal)); // after its output is read
  log(mode === 'ask' ? 'Scanning, and letting macOS ask for protected folders.' : 'Scanning.');
  broadcast('scan', scanInfo());
}

function onScanEvent(child, ev) {
  if (scan.child !== child) return;
  if (ev.type === 'progress') {
    scan.progress = {
      elapsed: ev.elapsed,
      files: ev.files,
      dirs: ev.dirs,
      bytes: ev.bytes,
      locked: ev.locked,
      protected: ev.protected,
      current: ev.current ? firmlinks.display(ev.current) : null,
      // The folder being read, relative to the Data volume, so the map can find its tile.
      at: ev.current?.startsWith(DATA + '/') ? ev.current.slice(DATA.length + 1) : null,
      waiting: ev.waiting?.map((w) => ({ path: firmlinks.display(w.path), seconds: w.seconds })) ?? [],
    };
    const message = { progress: scan.progress };
    if (ev.roots) {
      scan.live = ev.roots;
      if (!snap) message.tree = liveDiskTree();
    }
    broadcast('progress', message);
  } else if (ev.type === 'done') {
    scan.done = ev;
    finishScan(child, ev);
  } else if (ev.type === 'error') {
    scan.error = `The scanner stopped: ${ev.message}.`;
  }
}

async function finishScan(child, done) {
  scan.status = 'finishing';
  broadcast('scan', scanInfo());
  let disk = scan.model;
  try {
    disk = await liveDisk(true);
  } catch {
    // keep the disk as it was when the scan started
  }
  let error = null;
  try {
    renameSync(done.out, LATEST);
    const meta = { disk, scan: { ...done, out: undefined }, mode: scan.mode, startedAt: scan.startedAt, finishedAt: Date.now() };
    writeJson(LATEST_META, meta);
    load(LATEST, meta);
    rememberStalled(snap.stalledPaths());
    log(`Scan finished: ${done.files.toLocaleString('en-US')} files in ${Math.round(done.elapsed)} seconds.`);
  } catch (err) {
    error = `The scan finished, but its map could not be opened: ${err.message}`;
    removeQuietly(done.out);
  }
  endScan(child, error);
  if (!error) broadcast('snapshot', await publicState());
}

function onScanExit(child, code, signal) {
  if (scan.child !== child || scan.done) return;
  removeQuietly(scan.out);
  removeQuietly(`${scan.out}.partial`);
  let error = null;
  if (!scan.stopping) {
    const detail = scan.stderr.trim().split('\n').pop();
    error =
      scan.error ??
      (signal ? `The scanner was stopped by ${signal}.` : `The scanner quit with code ${code}.`) + (detail ? ` ${detail}` : '');
  }
  if (error) log(error);
  endScan(child, error);
}

function endScan(child, error) {
  if (scan.child !== child) return;
  Object.assign(scan, { child: null, status: 'idle', live: null, done: null, stopping: false, error });
  broadcast('scan', scanInfo());
}

function stopScan() {
  const child = scan.child;
  if (!child || scan.done) throw httpError(409, 'No scan is running.');
  scan.stopping = true;
  child.kill('SIGTERM');
  setTimeout(() => scan.child === child && child.kill('SIGKILL'), 2000).unref();
}

// ---------------------------------------------------------------- jettison list

// Things the user plans to delete, kept by path so the list survives rescans
// and is the same on every device. Once a newer scan no longer finds an
// item, it counts as freed.
let jettison = readJson(JETTISON_FILE)?.items ?? [];

const under = (path, base) => path === base || path.startsWith(base.endsWith('/') ? base : base + '/');

function jettisonView() {
  const scannedAt = snap ? snap.header.createdAt * 1000 : 0;
  let freed = 0,
    planned = 0;
  const items = jettison.map((it) => {
    const id = snap ? snap.find(it.path) : -1;
    const gone = Boolean(snap) && id < 0 && scannedAt > it.addedAt;
    const now = id > 0 ? Math.round(snap.size[id]) : null;
    if (gone) freed += it.size;
    else planned += now ?? it.size;
    return { ...it, id: id > 0 ? id : null, now, gone };
  });
  return { items, freed, planned };
}

function saveJettison() {
  writeJson(JETTISON_FILE, { items: jettison });
}

function changeJettison(body) {
  if (body.action === 'add') {
    const i = nodeId(body.id);
    const path = snap.path(i);
    const holder = jettison.find((it) => under(path, it.path));
    if (holder) throw httpError(409, `Already on the list, inside ${holder.name}.`);
    jettison = jettison.filter((it) => !under(it.path, path));
    jettison.push({ path, name: snap.name(i), size: Math.round(snap.size[i]), kind: snap.kindOf(i), addedAt: Date.now() });
  } else if (body.action === 'remove') {
    if (typeof body.path !== 'string') throw httpError(400, 'Say which path to remove.');
    jettison = jettison.filter((it) => it.path !== body.path);
  } else if (body.action === 'clear') {
    const gone = new Set(jettisonView().items.filter((it) => it.gone).map((it) => it.path));
    jettison = jettison.filter((it) => !gone.has(it.path));
  } else throw httpError(400, 'Unknown action.');
  saveJettison();
  const view = jettisonView();
  broadcast('jettison', view);
  return view;
}

// ---------------------------------------------------------------- state

function snapInfo() {
  if (!snap) return null;
  const h = snap.header;
  return {
    id: snap.id,
    createdAt: h.createdAt * 1000,
    elapsed: h.elapsed,
    files: h.files,
    dirs: h.dirs,
    bytes: h.bytes,
    full: h.full,
    priv: h.priv,
    linkedBytes: h.linkedBytes,
    clonedBytes: h.clonedBytes,
    minFile: h.minFile,
    locked: h.locked,
    protected: h.protected,
    stalled: h.stalled,
    errors: h.errors,
    protectedMode: h.protectedMode,
    access: h.access,
    disk: snapDisk && { size: snapDisk.size, free: snapDisk.free, at: snapDisk.at },
    source: snapSource === LATEST ? 'latest' : snapSource,
  };
}

async function publicState() {
  const disk = await liveDisk().catch(() => null);
  const view = jettisonView();
  return {
    app: 'spacewalk',
    machine,
    home: HOME,
    launchedFrom,
    kinds: KINDS,
    disk: disk && { name: disk.name, size: disk.size, free: disk.free, at: disk.at },
    others: disk?.others ?? [],
    snapshot: snapInfo(),
    scan: scanInfo(),
    jettison: { count: view.items.length, freed: view.freed, planned: view.planned },
  };
}

// ---------------------------------------------------------------- queries

function nodeId(raw) {
  if (!snap) throw httpError(404, 'There is no map yet. Start a scan first.');
  const i = Number(raw);
  if (!snap.valid(i)) throw httpError(404, 'Nothing on the map has that id.');
  return i;
}

function number(q, name, min, max, fallback) {
  const v = Number(q.get(name) ?? fallback);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

// Numeric ids belong to one snapshot. A client still holding ids from the
// previous one gets told, rather than shown the wrong folder.
function checkSnap(q) {
  const want = q.get('snap');
  if (want && want !== (snap?.id ?? '')) throw httpError(409, 'The map changed. Reload it.');
}

async function treeQuery(q) {
  checkSnap(q);
  const id = q.get('id') ?? 'disk';
  const depth = Math.round(number(q, 'depth', 1, 6, 4));
  const min = number(q, 'min', 0, 0.2, 0.002);
  let node;
  if (id === 'disk') {
    const model = diskModel() ?? (await liveDisk());
    node = diskTree(model, depth, model.size * min);
  } else {
    const i = nodeId(id);
    node = snap.tree(i, depth, snap.size[i] * min);
    const v = volumeOfRoot(i);
    if (v) dressVolume(node, v, HIDDEN);
  }
  return { snapshot: snap?.id ?? null, node };
}

async function nodeQuery(q) {
  checkSnap(q);
  const id = q.get('id') ?? 'disk';
  const model = diskModel() ?? (await liveDisk());
  if (id === 'disk')
    return { id, name: model.name, size: model.size, free: model.free, role: 'disk', note: NOTES.disk, others: model.others };
  if (id === 'free') {
    const now = await liveDisk().catch(() => null);
    return { id, name: 'Free', size: model.free, now: now?.free ?? null, role: 'free', note: NOTES.free };
  }
  if (id === 'overhead') return { id, name: 'APFS overhead', size: model.overhead, role: 'overhead', note: NOTES.overhead };
  if (id === 'hidden' || id === 'pending') {
    const data = model.volumes.find((v) => v.role === 'Data');
    const root = rootFor('Data');
    const scanned = root > 0 ? snap.size[root] : 0;
    return {
      ...(id === 'hidden' ? HIDDEN : PENDING),
      size: Math.max(0, Math.round((data?.used ?? 0) - scanned)),
      note: NOTES[id],
      unreadable: snap?.unreadable() ?? null,
      access: snap?.header.access ?? null,
      protectedMode: snap?.header.protectedMode ?? null,
      launchedFrom,
    };
  }
  if (id.startsWith('vol:')) {
    const v = model.volumes.find((x) => `vol:${x.role ?? x.dev}` === id);
    if (!v) throw httpError(404, 'No such volume.');
    return { ...volumeLeaf(v), note: NOTES[v.role] ?? NOTES.volume };
  }
  const i = nodeId(id);
  const node = snap.detail(i);
  const v = volumeOfRoot(i);
  if (v) dressVolume(node, v, HIDDEN);
  node.jettison = jettison.some((it) => under(node.path, it.path));
  return node;
}

// ---------------------------------------------------------------- http

const SECURITY = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const hostNames = new Set(['127.0.0.1', 'localhost', '[::1]']);
let tailnetName = null;

function hostAllowed(req) {
  const host = (req.headers.host ?? '').toLowerCase();
  const m = /^(.+):(\d+)$/.exec(host);
  if (!m || Number(m[2]) !== opt.port) return false;
  if (hostNames.has(m[1])) return true;
  // MagicDNS: this machine's name in any tailnet, as name.tailnet.ts.net
  return Boolean(tailnetName) && new RegExp(`^${tailnetName}\\.[a-z0-9-]+\\.ts\\.net$`).test(m[1]);
}

// A browser on this Mac, reached through the loopback address.
function isLocal(req) {
  return LOOPBACK.has(req.socket.remoteAddress) && /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/i.test(req.headers.host ?? '');
}

function send(req, res, status, body, headers = {}) {
  let data = Buffer.from(JSON.stringify(body));
  const out = { ...SECURITY, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers };
  if (data.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    data = gzipSync(data, { level: 5 });
    out['Content-Encoding'] = 'gzip';
    out.Vary = 'Accept-Encoding';
  }
  out['Content-Length'] = data.length;
  res.writeHead(status, out);
  res.end(req.method === 'HEAD' ? undefined : data);
}

function readBody(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError(413, 'That request is too large.'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(httpError(400, 'The request is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

// Changes need a custom header and a JSON body, which a page on another
// site cannot send without the browser asking first; nothing here answers.
function checkWrite(req) {
  if (req.headers['x-spacewalk'] !== '1') throw httpError(403, 'Missing the X-Spacewalk header.');
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw httpError(415, 'Send JSON.');
  const origin = req.headers.origin;
  if (origin && origin.toLowerCase() !== `http://${(req.headers.host ?? '').toLowerCase()}`)
    throw httpError(403, 'Requests from other sites are refused.');
}

const clients = new Set();

function push(res, message) {
  if (res.destroyed || res.writableEnded) clients.delete(res);
  else res.write(message);
}

function broadcast(type, data) {
  if (!clients.size) return;
  const message = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) push(res, message);
}

setInterval(() => {
  for (const res of clients) push(res, ': ping\n\n');
}, 15e3).unref();

function events(req, res) {
  res.writeHead(200, {
    ...SECURITY,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  res.write(`event: scan\ndata: ${JSON.stringify(scanInfo())}\n\n`);
  if (scan.live && !snap) res.write(`event: progress\ndata: ${JSON.stringify({ progress: scan.progress, tree: liveDiskTree() })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

async function api(req, res, url) {
  const q = url.searchParams;
  const route = `${req.method === 'HEAD' ? 'GET' : req.method} ${url.pathname}`;
  switch (route) {
    case 'GET /api/state':
      return send(req, res, 200, { ...(await publicState()), local: isLocal(req) });
    case 'GET /api/events':
      return events(req, res);
    case 'GET /api/tree':
      return send(req, res, 200, await treeQuery(q));
    case 'GET /api/node':
      return send(req, res, 200, await nodeQuery(q));
    case 'GET /api/search': {
      checkSnap(q);
      const text = (q.get('q') ?? '').trim().slice(0, 200);
      if (!snap || !text) return send(req, res, 200, { snapshot: snap?.id ?? null, total: 0, items: [] });
      const limit = Math.round(number(q, 'limit', 1, 200, 60));
      return send(req, res, 200, { snapshot: snap.id, ...snap.search(text, limit) });
    }
    case 'GET /api/find': {
      if (!snap) throw httpError(404, 'There is no map yet.');
      const i = snap.find(String(q.get('path') ?? ''));
      if (i < 0) throw httpError(404, 'That path is not on the map.');
      return send(req, res, 200, { snapshot: snap.id, id: i, path: snap.path(i) });
    }
    case 'GET /api/insights': {
      checkSnap(q);
      if (!snap) return send(req, res, 200, { snapshot: null });
      const id = q.get('id');
      const scope = id && /^\d+$/.test(id) ? nodeId(id) : 0;
      return send(req, res, 200, { snapshot: snap.id, ...snap.insights(scope) });
    }
    case 'GET /api/jettison':
      return send(req, res, 200, { snapshot: snap?.id ?? null, ...jettisonView() });
  }
  if (req.method !== 'POST') throw httpError(404, 'No such address.');
  checkWrite(req);
  const body = await readBody(req);
  switch (url.pathname) {
    case '/api/scan': {
      const mode = body.protected ?? 'auto';
      if (!['auto', 'skip', 'ask'].includes(mode)) throw httpError(400, 'Unknown mode.');
      // Asking puts permission prompts on this Mac's screen, so only someone there may start it.
      if (mode === 'ask' && !isLocal(req)) throw httpError(403, 'Only a browser on the Mac itself can start a scan that asks.');
      startScan(mode);
      return send(req, res, 202, scanInfo());
    }
    case '/api/scan/stop':
      stopScan();
      return send(req, res, 202, { ok: true });
    case '/api/reveal': {
      if (!isLocal(req)) throw httpError(403, 'Reveal in Finder works from a browser on the Mac itself.');
      const path = snap.path(nodeId(body.id));
      try {
        lstatSync(path);
      } catch (err) {
        if (err.code === 'ENOENT') throw httpError(410, 'It is not there any more. It was moved or deleted after the scan.');
      }
      await new Promise((resolve, reject) =>
        execFile('/usr/bin/open', ['-R', path], (err) => (err ? reject(httpError(500, 'Finder could not show it.')) : resolve())),
      );
      return send(req, res, 200, { ok: true });
    }
    case '/api/jettison':
      return send(req, res, 200, { snapshot: snap?.id ?? null, ...changeJettison(body) });
  }
  throw httpError(404, 'No such address.');
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};
const gzipped = new Map();

const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>Spacewalk</title>
<p style="font:16px/1.5 -apple-system,Helvetica,sans-serif;margin:40px">Spacewalk's web app is not built yet.
Start Spacewalk with <code>bin/spacewalk</code>, which builds it.</p>`;

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    throw httpError(400, 'Bad address.');
  }
  if (rel.includes('\0')) throw httpError(400, 'Bad address.');
  if (rel === '/') rel = '/index.html';
  const file = resolve(DIST, `.${rel}`);
  let stat = null;
  if (file.startsWith(DIST + sep)) {
    try {
      stat = statSync(file);
    } catch {
      // not there
    }
  }
  if (!stat?.isFile()) {
    if (rel === '/index.html') {
      res.writeHead(200, { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(NOT_BUILT);
    }
    throw httpError(404, 'Not found.');
  }
  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  const headers = {
    ...SECURITY,
    'Content-Type': type,
    'Cache-Control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  let data = readFileSync(file);
  if (/^(text|application\/json|image\/svg)/.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    const key = `${file}:${stat.mtimeMs}`;
    if (!gzipped.has(key)) gzipped.set(key, gzipSync(data, { level: 9 }));
    data = gzipped.get(key);
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = data.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : data);
}

async function handle(req, res) {
  try {
    if (!hostAllowed(req)) throw httpError(421, 'Spacewalk does not answer to that address.');
    const url = new URL(req.url, 'http://spacewalk');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Only GET here.');
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    if (!err.status) log(`Error on ${req.method} ${req.url}: ${err.stack ?? err.message}`);
    if (res.headersSent) return res.end();
    send(req, res, err.status ?? 500, {
      error: err.status ? err.message : 'Something went wrong on the Mac. The server log says more.',
      snapshot: snap?.id ?? null,
    });
  }
}

// ---------------------------------------------------------------- start

function tailnetAddress() {
  for (const addrs of Object.values(os.networkInterfaces()))
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [x, y] = a.address.split('.').map(Number);
      if (x === 100 && y >= 64 && y <= 127) return a.address; // Tailscale's 100.64.0.0/10
    }
  return null;
}

function listen(host) {
  const server = http.createServer(handle);
  server.keepAliveTimeout = 30e3;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opt.port, host, () => {
      server.off('error', reject);
      server.on('error', (err) => log(`Server error: ${err.message}`));
      resolve(server);
    });
  });
}

function openBrowser(url) {
  if (opt.open && !process.env.SSH_CONNECTION) execFile('/usr/bin/open', [url], () => {});
}

async function alreadyRunning(url) {
  try {
    const res = await fetch(`${url}api/state`, { signal: AbortSignal.timeout(2000) });
    if ((await res.json()).app === 'spacewalk') {
      log(`Spacewalk is already running at ${url}`);
      if (opt.tailnet) log('To change how it runs, stop it first with Ctrl-C in its window.');
      openBrowser(url);
      process.exit(0);
    }
  } catch {
    // something else holds the port
  }
  console.error(`Another program is using port ${opt.port}. Choose a different one with --port.`);
  process.exit(1);
}

function age(ms) {
  const min = Math.round(ms / 60e3);
  if (min < 1) return 'moments ago';
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
}

async function main() {
  mkdirSync(CACHE, { recursive: true });
  for (const name of readdirSync(CACHE)) if (/^scan-\d+\.spwk/.test(name)) removeQuietly(join(CACHE, name)); // left by a scan that never finished
  const file = opt.snapshot ?? (existsSync(LATEST) ? LATEST : null);
  if (file) {
    try {
      load(file, opt.snapshot ? null : readJson(LATEST_META));
    } catch (err) {
      log(`Could not open ${file}: ${err.message}`);
    }
  }
  liveDisk().catch((err) => log(`diskutil did not answer: ${err.message}`));

  const local = `http://127.0.0.1:${opt.port}/`;
  const servers = [];
  try {
    servers.push(await listen('127.0.0.1'));
  } catch (err) {
    if (err.code === 'EADDRINUSE') await alreadyRunning(local);
    throw err;
  }
  const lines = [`  On this Mac     ${local}`];
  if (opt.tailnet) {
    const ip = tailnetAddress();
    if (!ip) log('Tailscale is not connected on this Mac, so the map is only on this Mac.');
    else {
      tailnetName = machine.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
      for (const name of [ip, tailnetName, ...opt.hosts]) hostNames.add(name);
      try {
        servers.push(await listen(ip));
        lines.push(`  On your tailnet http://${tailnetName}:${opt.port}/  (or http://${ip}:${opt.port}/)`);
      } catch (err) {
        log(`Could not listen on the tailnet address ${ip}: ${err.message}`);
      }
    }
  }
  log(`Spacewalk\n${lines.join('\n')}`);

  const fresh = snap && Date.now() - snap.header.createdAt * 1000 < AUTO_SCAN_AFTER;
  if (snap) log(`Showing the scan from ${age(Date.now() - snap.header.createdAt * 1000)}.`);
  if (opt.scan === 'yes' || (opt.scan === 'auto' && !opt.snapshot && !fresh)) {
    try {
      startScan('auto');
    } catch (err) {
      log(err.message);
    }
  }
  log('Press Ctrl-C to stop.');
  openBrowser(local);

  const quit = () => {
    scan.child?.kill('SIGTERM');
    for (const res of clients) res.end();
    for (const s of servers) s.close();
    process.exit(0);
  };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}

main().catch((err) => {
  console.error(err.stack ?? err.message);
  process.exit(1);
});
