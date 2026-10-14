// Reads a spacewalk-scan snapshot (format version 2) and answers the map,
// inspector, search and insight queries against it. Nodes sit in pre-order
// with children largest first, so the subtree of node i is the index range
// [i, i + span[i]) and its first child, when it has one, is i + 1.

import { readFileSync } from 'node:fs';
import { KINDS, classify } from './kinds.mjs';

export const NF = {
  DIR: 1 << 0, // folder
  LOCKED: 1 << 1, // could not be read
  OTHERFS: 1 << 2, // mount point or firmlink into another volume, not followed
  HARDLINK: 1 << 3, // file with several names, counted once
  DATALESS: 1 << 4, // cloud placeholder, contents not on this disk
  STALLED: 1 << 5, // the scan stopped waiting on it
  PARTIAL: 1 << 6, // listing ended early
  ROOT: 1 << 7, // a scan root
  CLONE: 1 << 8, // APFS clone sharing every block with another file
  SHARED: 1 << 9, // may share some blocks with other files
  PURGEABLE: 1 << 10, // macOS may remove it when space runs low
  GATED: 1 << 11, // macOS may guard it with a permission prompt
  SKIPPED: 1 << 12, // left unopened on request
  ASK: 1 << 13, // left unopened because macOS would ask first; err holds the service
};

// The privacy service in err for a folder left unopened, numbered as the scanner numbers them.
export const SERVICES = [null, 'fullDisk', 'appData', 'desktop', 'documents', 'downloads', 'cloud'];

const KIND_KEYS = Object.keys(KINDS);
const STALE_AGE = 90 * 86400; // folders unchanged this long are worth a look
const align8 = (n) => (n + 7) & ~7;
const utf8 = new TextDecoder();

export function readSnapshot(file, firmlinks) {
  const raw = readFileSync(file);
  const bytes = new Uint8Array(raw.length); // its own buffer, so every array below is aligned
  bytes.set(raw);
  const buf = bytes.buffer;
  const view = new DataView(buf);
  if (utf8.decode(bytes.subarray(0, 8)) !== 'SPWKSNAP') throw new Error('not a Spacewalk snapshot');
  const version = view.getUint32(8, true);
  if (version !== 2) throw new Error(`snapshot format ${version} is not supported`);
  const hlen = view.getUint32(12, true);
  const header = JSON.parse(utf8.decode(bytes.subarray(16, 16 + hlen)));
  let off = align8(16 + hlen);
  const n = view.getUint32(off, true);
  const namesLen = view.getUint32(off + 4, true);
  off = align8(off + 8);
  const take = (Type, count) => {
    const a = new Type(buf, off, count);
    off = align8(off + count * Type.BYTES_PER_ELEMENT);
    return a;
  };
  return new Snapshot(
    header,
    {
      n,
      size: take(Float64Array, n),
      full: take(Float64Array, n),
      priv: take(Float64Array, n),
      smallBytes: take(Float64Array, n),
      parent: take(Int32Array, n),
      span: take(Uint32Array, n),
      files: take(Uint32Array, n),
      dirs: take(Uint32Array, n),
      smallCount: take(Uint32Array, n),
      mtime: take(Uint32Array, n),
      mtimeMax: take(Uint32Array, n),
      nameOff: take(Uint32Array, n),
      nameLen: take(Uint16Array, n),
      flags: take(Uint16Array, n),
      err: take(Uint8Array, n),
      names: take(Uint8Array, namesLen),
    },
    firmlinks,
  );
}

export class Snapshot {
  constructor(header, arrays, firmlinks) {
    Object.assign(this, arrays);
    this.header = header;
    this.firmlinks = firmlinks;
    this.id = `${header.createdAt}-${arrays.n}`;
    this.roots = new Map(header.roots.map((r) => [r.index, r]));
    this.nameCache = new Array(this.n);
    this.kindCache = new Int8Array(this.n).fill(-2); // -2 not worked out yet, -1 none
    // Steps below the scan root; parents always come before children.
    this.depth = new Uint16Array(this.n);
    for (let i = 1; i < this.n; i++) this.depth[i] = this.flags[i] & NF.ROOT ? 0 : this.depth[this.parent[i]] + 1;
  }

  valid(i) {
    return Number.isInteger(i) && i > 0 && i < this.n;
  }

  name(i) {
    let s = this.nameCache[i];
    if (s === undefined) {
      const o = this.nameOff[i];
      s = this.nameCache[i] = utf8.decode(this.names.subarray(o, o + this.nameLen[i]));
    }
    return s;
  }

  isDir(i) {
    return (this.flags[i] & NF.DIR) !== 0;
  }

  *children(i) {
    const end = i + this.span[i];
    for (let c = i + 1; c < end; c += this.span[c]) yield c;
  }

  childNamed(i, name) {
    for (const c of this.children(i)) if (this.name(c) === name) return c;
    return -1;
  }

  rawPath(i) {
    const parts = [];
    while (i > 0 && !(this.flags[i] & NF.ROOT)) {
      parts.push(this.name(i));
      i = this.parent[i];
    }
    const root = this.roots.get(i);
    if (!root) return '/';
    if (!parts.length) return root.path;
    return (root.path === '/' ? '' : root.path) + '/' + parts.reverse().join('/');
  }

  path(i) {
    return this.firmlinks.display(this.rawPath(i));
  }

  // The node for a path, written either way (/Users/... or /System/Volumes/Data/Users/...), or -1.
  find(path) {
    const raw = this.firmlinks.raw(path.replace(/\/+$/, '') || '/');
    for (const root of this.roots.values()) {
      const base = root.path === '/' ? '' : root.path;
      if (raw !== root.path && !raw.startsWith(base + '/')) continue;
      let i = root.index;
      for (const part of raw.slice(base.length).split('/').filter(Boolean)) {
        i = this.childNamed(i, part);
        if (i < 0) break;
      }
      if (i >= 0) return i;
    }
    return -1;
  }

  // What node i is on its own, judged by its name and the names above it.
  kindSelf(i) {
    let k = this.kindCache[i];
    if (k === -2) {
      let kind = null;
      if (i > 0 && !(this.flags[i] & NF.ROOT)) {
        const up = [this.name(i)];
        for (let p = this.parent[i]; up.length < 4 && p > 0 && !(this.flags[p] & NF.ROOT); p = this.parent[p])
          up.push(this.name(p));
        kind = classify(
          this.isDir(i),
          up,
          this.depth[i],
          (name) => this.childNamed(this.parent[i], name) >= 0,
          (name) => this.childNamed(i, name) >= 0,
        );
      }
      k = this.kindCache[i] = kind ? KIND_KEYS.indexOf(kind) : -1;
    }
    return k < 0 ? null : KIND_KEYS[k];
  }

  // A node's kind given the kind around it. Some kinds take in everything
  // inside them (an app, a git history, a Photos library). Inside something
  // reclaimable, everything stays reclaimable (a zip inside node_modules goes
  // with node_modules), except downloaded models, which are worth keeping
  // apart from the cache they sit in.
  static merge(outer, own) {
    if (outer && (KINDS[outer].whole || (KINDS[outer].tone === 'reclaim' && own !== 'model'))) return outer;
    return own ?? outer;
  }

  kindOf(i) {
    const chain = [];
    for (let p = i; p > 0; p = this.parent[p]) chain.push(p);
    let kind = null;
    for (let k = chain.length - 1; k >= 0; k--) kind = Snapshot.merge(kind, this.kindSelf(chain[k]));
    return kind;
  }

  // How much of each node is safe to delete (rc) and worth a look (rv), as
  // the map colours it. Every byte takes the tone of the kind around it
  // (see merge). Apps, repositories and swap keep their insides out of both,
  // and media takes the tone of the folder it sits in, so a film in
  // Downloads is still worth a look.
  heat() {
    if (this.rc) return;
    const n = this.n;
    const kind = new Array(n).fill(null);
    const tone = new Uint8Array(n); // 0 keep, 1 worth a look, 2 safe to delete
    for (let i = 1; i < n; i++) {
      const p = this.parent[i] > 0 ? this.parent[i] : 0;
      const k = (kind[i] = Snapshot.merge(kind[p], this.kindSelf(i)));
      const t = k && KINDS[k].tone;
      tone[i] = t === 'reclaim' ? 2 : t === 'review' ? 1 : k && KINDS[k].whole ? 0 : tone[p];
    }
    const rc = new Float64Array(n);
    const rv = new Float64Array(n);
    const inner = new Float64Array(n); // bytes in each node's children
    for (let i = n - 1; i > 0; i--) {
      const own = Math.max(0, this.size[i] - inner[i]);
      if (tone[i] === 2) rc[i] += own;
      else if (tone[i] === 1) rv[i] += own;
      const p = this.parent[i];
      if (p > 0) {
        rc[p] += rc[i];
        rv[p] += rv[i];
        inner[p] += this.size[i];
      }
    }
    this.rc = rc;
    this.rv = rv;
  }

  summary(i, kind) {
    this.heat();
    const f = this.flags[i];
    const s = {
      id: i,
      name: this.name(i),
      size: Math.round(this.size[i]),
      full: Math.round(this.full[i]),
      priv: Math.round(this.priv[i]),
      files: this.files[i],
      dirs: this.dirs[i],
      flags: f,
      mtime: this.mtimeMax[i],
    };
    if (this.rc[i] >= 1) s.rc = Math.round(this.rc[i]);
    if (this.rv[i] >= 1) s.rv = Math.round(this.rv[i]);
    if (kind) s.kind = kind;
    if (f & (NF.LOCKED | NF.PARTIAL)) s.err = this.err[i];
    if (f & NF.ASK) s.service = SERVICES[this.err[i]] ?? null;
    if (f & NF.DIR) s.open = this.span[i] > 1 || this.smallCount[i] > 0;
    // Where its subtree ends in the pre-order: the client tells what lies inside it by id.
    if (f & NF.DIR && this.span[i] > 1) s.end = i + this.span[i];
    return s;
  }

  // Node i with its children, depth levels deep. Children smaller than
  // minSize are summed into rest; files under the scanner's threshold are in small.
  tree(i, depth, minSize, outer = this.kindOf(this.parent[i])) {
    const kind = Snapshot.merge(outer, this.kindSelf(i));
    const node = this.summary(i, kind);
    if (depth <= 0 || !this.isDir(i)) return node;
    const kids = [];
    let shown = 0,
      hidden = 0;
    for (const c of this.children(i)) {
      if (this.size[c] >= minSize && kids.length < 300) {
        kids.push(this.tree(c, depth - 1, minSize, kind));
        shown += this.size[c];
      } else hidden++;
    }
    node.kids = kids;
    const small = this.smallBytes[i];
    if (this.smallCount[i]) node.small = { count: this.smallCount[i], size: Math.round(small) };
    if (hidden) node.rest = { count: hidden, size: Math.max(0, Math.round(this.size[i] - shown - small)) };
    return node;
  }

  detail(i) {
    const chain = [];
    for (let p = i; p > 0; p = this.parent[p]) chain.push(p);
    chain.reverse();
    let kind = null;
    for (const p of chain) kind = Snapshot.merge(kind, this.kindSelf(p));
    const s = this.summary(i, kind);
    s.path = this.path(i);
    s.ancestors = chain.slice(0, -1).map((p) => ({ id: p, name: this.name(p) }));
    s.modified = this.mtime[i];
    if (this.isDir(i)) {
      let count = 0;
      for (const _ of this.children(i)) count++;
      s.children = count;
      s.small = { count: this.smallCount[i], size: Math.round(this.smallBytes[i]) };
    }
    return s;
  }

  item(i, kind = this.kindOf(i)) {
    const s = this.summary(i, kind);
    s.path = this.path(i);
    return s;
  }

  search(query, limit) {
    const needle = query.toLowerCase();
    if (!this.lower) {
      this.lower = new Array(this.n);
      for (let i = 0; i < this.n; i++) this.lower[i] = this.name(i).toLowerCase();
    }
    const hits = [];
    for (let i = 1; i < this.n; i++) if (this.lower[i].includes(needle)) hits.push(i);
    hits.sort((a, b) => this.size[b] - this.size[a]);
    return { total: hits.length, items: hits.slice(0, limit).map((i) => this.item(i)) };
  }

  // Where space can come back from, on the whole map or inside one folder
  // (scope). A category counts the folders and files where its kind begins,
  // as the map colours them (see merge), so reclaimable categories never
  // overlap and add up to the reclaim total. Categories worth a look may hold
  // reclaimable things. Inside a folder that is itself reclaimable, or worth
  // a look, its contents are the items.
  insights(scope = 0) {
    const key = this.valid(scope) ? scope : 0;
    this.insightCache ??= new Map();
    const hit = this.insightCache.get(key);
    if (hit) return hit;
    this.heat();
    const now = this.header.createdAt;
    const cats = new Map();
    const reclaim = { size: 0, priv: 0, count: 0 };
    // Enclosing folders: { end, kind, cat, sealed }. sealed: inside an app,
    // repository or other whole thing that begins within the scope.
    const regions = [];
    let first = 1,
      last = this.n;
    if (key) {
      first = key + 1;
      last = key + this.span[key];
      regions.push({ end: last, kind: this.kindOf(key), cat: null, sealed: false, scope: true });
    }
    let staleEnd = 0;
    const files = [],
      stale = [];
    const users = this.find('/Users');
    const usersEnd = users > 0 ? users + this.span[users] : 0;
    const add = (c, i, sign = 1) => {
      c.size += sign * this.size[i];
      c.priv += sign * this.priv[i];
    };
    for (let i = first; i < last; i++) {
      while (regions.length && i >= regions[regions.length - 1].end) regions.pop();
      const around = regions[regions.length - 1];
      const outer = around?.kind ?? null;
      const kind = Snapshot.merge(outer, this.kindSelf(i));
      const end = i + this.span[i];
      let cat = around?.cat ?? null;
      const begins = kind !== outer || (around?.scope && this.parent[i] === key);
      if (kind && begins && KINDS[kind].tone !== 'neutral') {
        cat = cats.get(kind);
        if (!cat) cats.set(kind, (cat = { kind, size: 0, priv: 0, count: 0, ids: [] }));
        add(cat, i);
        cat.count++;
        cat.ids.push(i);
        if (KINDS[kind].tone === 'reclaim') {
          add(reclaim, i);
          reclaim.count++;
        } else if (kind === 'model') {
          const host = regions.findLast((r) => r.kind && KINDS[r.kind].tone === 'reclaim');
          if (host?.cat) {
            add(host.cat, i, -1);
            add(reclaim, i, -1);
          }
        }
      }
      const sealed = Boolean(around?.sealed || (kind && KINDS[kind].whole && kind !== outer));
      if (end > i + 1) regions.push({ end, kind, cat, sealed });
      // The insides of an app, a repository or a VM are not things to delete one by one.
      if (around?.sealed) continue;
      if (!this.isDir(i)) files.push(i);
      else if (
        i >= staleEnd &&
        i > users &&
        i < usersEnd &&
        this.size[i] >= 5e8 &&
        this.mtimeMax[i] > 0 &&
        now - this.mtimeMax[i] > STALE_AGE
      ) {
        if (kind !== 'app' && kind !== 'git') stale.push(i); // an app's date says when it was installed, not used
        staleEnd = end;
      }
    }
    const bySize = (a, b) => this.size[b] - this.size[a];
    const all = [...cats.values()];
    // The biggest single things to delete, and to look at, across every category.
    const ranked = (tone, measure, limit) =>
      all
        .filter((c) => KINDS[c.kind].tone === tone)
        .flatMap((c) => c.ids)
        .filter((i) => measure[i] >= 1)
        .sort((a, b) => measure[b] - measure[a])
        .slice(0, limit)
        .map((i) => this.item(i));
    const categories = all
      .filter((c) => c.size >= 1e6)
      .sort((a, b) => b.size - a.size)
      .map((c) => ({
        kind: c.kind,
        label: KINDS[c.kind].label,
        tone: KINDS[c.kind].tone,
        blurb: KINDS[c.kind].blurb,
        size: Math.round(c.size),
        priv: Math.round(c.priv),
        count: c.count,
        items: c.ids.sort(bySize).slice(0, 40).map((i) => this.item(i)),
      }));
    // Totals as the map colours them.
    const tops = key ? [key] : [...this.roots.keys()];
    const total = (a) => Math.round(tops.reduce((sum, i) => sum + a[i], 0));
    const result = {
      scope: key || null,
      size: Math.round(tops.reduce((sum, i) => sum + this.size[i], 0)),
      reclaim: { size: total(this.rc), priv: Math.round(reclaim.priv), count: reclaim.count },
      review: { size: total(this.rv) },
      categories,
      top: { reclaim: ranked('reclaim', this.rc, 80), review: ranked('review', this.rv, 50) },
      files: files.sort(bySize).slice(0, 40).map((i) => this.item(i)),
      stale: stale.sort(bySize).slice(0, 30).map((i) => this.item(i)),
      staleDays: STALE_AGE / 86400,
    };
    // Keep the whole-map answer; let folder answers come and go.
    if (this.insightCache.size >= 24) this.insightCache.delete([...this.insightCache.keys()].find((k) => k !== 0));
    this.insightCache.set(key, result);
    return result;
  }

  // What the scan left unread, grouped by reason and by the folder it sits in.
  unreadable() {
    if (this.cachedUnreadable) return this.cachedUnreadable;
    const groups = new Map();
    for (let i = 1; i < this.n; i++) {
      const f = this.flags[i];
      let key = null;
      if (f & NF.ASK) key = SERVICES[this.err[i]] ?? 'appData';
      else if (f & (NF.LOCKED | NF.PARTIAL)) key = 'locked';
      else if (f & NF.STALLED) key = 'stalled';
      else if (f & NF.SKIPPED) key = 'skipped';
      if (!key) continue;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { count: 0, places: new Map() }));
      g.count++;
      g.places.set(this.parent[i], (g.places.get(this.parent[i]) ?? 0) + 1);
    }
    const out = {};
    for (const [key, g] of groups)
      out[key] = {
        count: g.count,
        places: [...g.places]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([p, count]) => ({ id: p, path: this.path(p), count })),
      };
    return (this.cachedUnreadable = out);
  }

  // Folders the scan stopped waiting on, to leave unopened next time. Ones
  // behind a permission prompt are left out: they waited on a person, and a
  // later scan that asks should ask again.
  stalledPaths() {
    const out = [];
    for (let i = 1; i < this.n; i++)
      if ((this.flags[i] & (NF.STALLED | NF.GATED)) === NF.STALLED) out.push(this.rawPath(i));
    return out;
  }
}
