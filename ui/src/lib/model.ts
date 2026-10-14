// The map's tree on this side: the parts of the disk the app has loaded,
// joined into one tree. Every node has a key made of the names on its way
// down from the disk, so the same folder keeps its key across reloads and
// rescans; the map animates between layouts by key.

import { NF, type RawNode } from './api';

export type Role = 'disk' | 'volume' | 'dir' | 'file' | 'hidden' | 'pending' | 'free' | 'overhead' | 'more';

export interface MNode {
  key: string;
  /** The server's id for it: a number for scanned items, a word for the disk's parts. */
  id: string | null;
  name: string;
  role: Role;
  size: number;
  /** Bytes safe to delete and worth a look, as the map colours them. */
  rc: number;
  rv: number;
  priv: number | null;
  files: number;
  dirs: number;
  mtime: number;
  kind: string | null;
  flags: number;
  /** Has contents to dive into. */
  open: boolean;
  parent: MNode | null;
  /** Loaded children, largest first; null until loaded. */
  kids: MNode[] | null;
  /** kids holds only some of the children. */
  partial: boolean;
  /** Stands in for a folder that is not loaded yet; its numbers are unknown. */
  stub: boolean;
  /** For the "more" tile: how many items it stands for. */
  count: number;
  volume: string | null;
  note: string | null;
  live: boolean;
  /** The smallest child size the load that found this node's children sent. */
  minAbs: number;
  /** One past the last scanned id inside it, or 0. */
  end: number;
}

const MARK = '\u0001';
export const DISK_KEY = 'disk';

export function childKey(parentKey: string, raw: RawNode): string {
  if (raw.volume || raw.role === 'volume') return `${parentKey}/${MARK}${raw.volume ?? raw.name}`;
  if (raw.role === 'hidden' || raw.role === 'pending' || raw.role === 'free' || raw.role === 'overhead')
    return `${parentKey}/${MARK}${raw.role}`;
  return `${parentKey}/${raw.name}`;
}

export function parentKeyOf(key: string): string | null {
  const at = key.lastIndexOf('/');
  return at < 0 ? null : key.slice(0, at);
}

export function isInside(key: string, ancestorKey: string): boolean {
  return key.length > ancestorKey.length && key.startsWith(ancestorKey) && key[ancestorKey.length] === '/';
}

function roleOf(raw: RawNode): Role {
  if (raw.role === 'disk' || raw.id === 'disk') return 'disk';
  if (raw.volume || raw.role === 'volume') return 'volume';
  if (raw.role === 'hidden' || raw.role === 'pending' || raw.role === 'free' || raw.role === 'overhead') return raw.role;
  return raw.flags & NF.DIR ? 'dir' : 'file';
}

function blank(key: string, parent: MNode | null): MNode {
  return {
    key,
    id: null,
    name: '',
    role: 'dir',
    size: 0,
    rc: 0,
    rv: 0,
    priv: null,
    files: 0,
    dirs: 0,
    mtime: 0,
    kind: null,
    flags: 0,
    open: false,
    parent,
    kids: null,
    partial: false,
    stub: false,
    count: 0,
    volume: null,
    note: null,
    live: false,
    minAbs: Infinity,
    end: 0,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Largest first, except the parts that are not things: the rest of the small
// items, what is still to scan, overhead and free space close the map at its
// far corner, where they sit in the same place at every level.
const TAIL: Partial<Record<Role, number>> = { more: 1, pending: 2, overhead: 3, free: 4 };
const order = (a: MNode, b: MNode) => (TAIL[a.role] ?? 0) - (TAIL[b.role] ?? 0) || b.size - a.size;

function build(
  raw: RawNode,
  parent: MNode | null,
  key: string,
  old: Map<string, MNode> | null,
  live: boolean,
  minAbs: number,
): MNode {
  const n = blank(key, parent);
  n.role = roleOf(raw);
  n.id = raw.id !== undefined && !live ? String(raw.id) : null;
  if (live && raw.id === 'disk') n.id = 'disk';
  n.name = raw.name;
  n.size = raw.size;
  n.rc = raw.rc ?? 0;
  n.rv = raw.rv ?? 0;
  n.priv = raw.priv ?? null;
  n.files = raw.files ?? 0;
  n.dirs = raw.dirs ?? 0;
  n.mtime = raw.mtime ?? 0;
  n.kind = raw.kind ?? null;
  n.flags = raw.flags ?? 0;
  n.open = !live && (n.role === 'disk' || Boolean(raw.open));
  n.volume = raw.volume ?? null;
  n.note = raw.note ?? null;
  n.live = live;
  n.end = !live && typeof raw.end === 'number' ? raw.end : 0;
  if (raw.kids) {
    n.minAbs = minAbs;
    const kids = raw.kids.filter((k) => k.size > 0).map((k) => build(k, n, childKey(key, k), old, live, minAbs));
    let inner = 0;
    let krc = 0;
    let krv = 0;
    for (const k of kids) {
      inner += k.size;
      krc += k.rc;
      krv += k.rv;
    }
    // What the list left out: items too small to send, and files under the scanner's size floor.
    const rest = n.size - inner;
    if (rest > 0 && rest > n.size * 4e-4) {
      const more = blank(`${key}/${MARK}more`, n);
      more.role = 'more';
      more.count = (raw.rest?.count ?? 0) + (raw.small?.count ?? 0);
      more.name = more.count ? `${more.count.toLocaleString('en-US')} more` : 'Everything else';
      more.size = rest;
      more.rc = clamp(n.rc - krc, 0, rest);
      more.rv = clamp(n.rv - krv, 0, rest - more.rc);
      more.live = live;
      kids.push(more);
    }
    kids.sort(order);
    n.kids = kids;
  } else if (old) {
    // Keep what an earlier, deeper load found below this node.
    const prev = old.get(key);
    if (prev?.kids && prev.id === n.id) {
      n.kids = prev.kids;
      n.partial = prev.partial || prev.stub;
      n.minAbs = prev.minAbs;
      for (const k of n.kids) k.parent = n;
    }
  }
  return n;
}

export class Tree {
  root: MNode | null = null;
  byKey = new Map<string, MNode>();
  byId = new Map<string, MNode>();
  live = false;

  private reindex() {
    this.byKey.clear();
    this.byId.clear();
    const walk = (n: MNode) => {
      this.byKey.set(n.key, n);
      if (n.id) this.byId.set(n.id, n);
      if (n.kids) for (const k of n.kids) walk(k);
    };
    if (this.root) walk(this.root);
  }

  clear() {
    this.root = null;
    this.live = false;
    this.reindex();
  }

  /** Put a loaded subtree in place, keeping deeper levels loaded earlier. */
  graft(raw: RawNode, key: string, minAbs: number, live = false): MNode {
    const prev = this.byKey.get(key);
    const pk = parentKeyOf(key);
    const parent = prev?.parent ?? (pk ? (this.byKey.get(pk) ?? null) : null);
    const fresh = build(raw, parent, key, live ? null : this.byKey, live, minAbs);
    if (!parent) {
      this.root = fresh;
      this.live = live;
    } else if (!parent.kids) {
      parent.kids = [fresh];
      parent.partial = true;
    } else {
      const at = parent.kids.findIndex((k) => k.key === key);
      if (at >= 0) parent.kids[at] = fresh;
      else {
        parent.kids.push(fresh);
        parent.kids.sort(order);
        parent.partial = true;
      }
    }
    this.reindex();
    return fresh;
  }

  /** Make sure every folder on a node's way down exists, as stubs where not loaded. */
  ensureChain(rootId: string, names: { id: number; name: string }[]): string | null {
    const root = this.byId.get(rootId);
    if (!root) return null;
    let at = root;
    for (const step of names) {
      const key = `${at.key}/${step.name}`;
      let next = this.byKey.get(key);
      if (!next) {
        next = blank(key, at);
        next.id = String(step.id);
        next.name = step.name;
        next.open = true;
        next.stub = true;
        next.flags = NF.DIR;
        if (!at.kids) {
          at.kids = [];
          at.partial = true;
        } else if (!at.partial) at.partial = true;
        at.kids.push(next);
        this.byKey.set(key, next);
        this.byId.set(next.id!, next);
      }
      at = next;
    }
    return at.key;
  }

  get(key: string | null | undefined): MNode | null {
    return key ? (this.byKey.get(key) ?? null) : null;
  }
}

export function canDive(n: MNode | null): boolean {
  if (!n || n.live || !n.open || !n.id) return false;
  if (n.role !== 'dir' && n.role !== 'volume' && n.role !== 'disk') return false;
  return !n.kids || n.kids.some((k) => k.role !== 'more') || n.partial;
}

/** How many levels below n are loaded. */
export function loadedDepth(n: MNode, cap = 4): number {
  if (!n.kids || cap <= 0) return 0;
  let d = 0;
  for (const k of n.kids) if (k.kids) d = Math.max(d, loadedDepth(k, cap - 1));
  return 1 + d;
}

/** Whether n needs loading before the map can show it as the focus. */
export function needsLoad(n: MNode, levels = 3): boolean {
  if (!n.open || n.live || !n.id) return false;
  if (!n.kids || n.partial || n.stub) return true;
  if (n.minAbs > Math.max(1, n.size * 1.5e-3)) return true;
  return loadedDepth(n, levels) < Math.min(levels, 2);
}

/** The one child that holds all of a loaded folder, as Users holds the one home folder. */
export function soleChild(n: MNode): MNode | null {
  if (!n.kids || n.partial || n.stub || n.role === 'file' || n.role === 'more') return null;
  let total = 0;
  for (const k of n.kids) total += k.size;
  const first = n.kids[0];
  return first && first.role !== 'more' && first.size > 0 && first.size >= total * 0.995 ? first : null;
}

export function ancestors(n: MNode): MNode[] {
  const out: MNode[] = [];
  for (let p = n.parent; p; p = p.parent) out.push(p);
  return out.reverse();
}

/** A scanned item, as opposed to a part of the disk the scan does not cover. */
export function isScanned(n: MNode | null): n is MNode & { id: string } {
  return Boolean(n?.id && /^\d+$/.test(n.id));
}
