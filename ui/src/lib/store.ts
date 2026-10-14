// Everything the screen shows, in one place: the server's state, the loaded
// tree, where the map is looking, what is hovered and selected, the lists
// and the search. Components read it with useView; the map, the lists and
// search all write to the same hover and selection, so they light together.

import { useSyncExternalStore } from 'react';
import {
  ApiError,
  get,
  post,
  type Detail,
  type Insights,
  type Item,
  type JettisonView,
  type RawNode,
  type ScanInfo,
  type ScanProgress,
  type SearchResult,
  type ServerState,
} from './api';
import { copyText } from './copy';
import { DISK_KEY, Tree, canDive, isInside, isScanned, needsLoad, parentKeyOf, soleChild, type MNode } from './model';

export type Tab = 'reclaim' | 'largest' | 'marked';

export interface View {
  state: ServerState | null;
  conn: 'connecting' | 'open' | 'lost';
  bootError: string | null;
  treeVersion: number;
  focusKey: string;
  selectedKey: string | null;
  hoverKey: string | null;
  /** The item the inspector shows: the selection, or else the focus. */
  inspect: { key: string; detail: Detail | null; loading: boolean; error: string | null } | null;
  insights: Insights | null;
  insightsLoading: boolean;
  jettison: JettisonView | null;
  query: string;
  search: SearchResult | null;
  searching: boolean;
  progress: ScanProgress | null;
  tab: Tab;
  /** A navigation is waiting on the server. */
  busy: boolean;
}

export interface Notice {
  body: string;
  type?: 'info' | 'error';
  id?: string;
}

const MIN_FRACTION = 8e-4; // children smaller than this share of the focus are summed into "more"
const DATA_PATHS: Record<string, string> = { Data: '/System/Volumes/Data', VM: '/System/Volumes/VM' };

type Listener = () => void;

class Store {
  tree = new Tree();
  view: View = {
    state: null,
    conn: 'connecting',
    bootError: null,
    treeVersion: 0,
    focusKey: DISK_KEY,
    selectedKey: null,
    hoverKey: null,
    inspect: null,
    insights: null,
    insightsLoading: false,
    jettison: null,
    query: '',
    search: null,
    searching: false,
    progress: null,
    tab: 'reclaim',
    busy: false,
  };
  private listeners = new Set<Listener>();
  private noticeListeners = new Set<(n: Notice) => void>();
  private paths = new Map<string, string>(); // id -> path
  private insightCache = new Map<string, Insights>();
  private loading = new Map<string, Promise<void>>();
  private navSeq = 0;
  private inspectSeq = 0;
  private searchSeq = 0;
  private searchTimer = 0;
  private inspectTimer = 0;
  private events: EventSource | null = null;
  private started = false;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  get = () => this.view;

  private set(patch: Partial<View>) {
    this.view = { ...this.view, ...patch };
    for (const l of this.listeners) l();
  }

  private bump() {
    this.set({ treeVersion: this.view.treeVersion + 1 });
  }

  onNotice(l: (n: Notice) => void) {
    this.noticeListeners.add(l);
    return () => {
      this.noticeListeners.delete(l);
    };
  }

  notify(n: Notice) {
    for (const l of this.noticeListeners) l(n);
  }

  private fail(err: unknown, prefix?: string) {
    if ((err as Error)?.name === 'AbortError') return;
    if (err instanceof ApiError && err.status === 409) {
      void this.reloadAll();
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    this.notify({ body: prefix ? `${prefix} ${message}` : message, type: 'error' });
  }

  get snapId(): string | null {
    return this.view.state?.snapshot?.id ?? null;
  }

  // ------------------------------------------------------------ start

  async start() {
    if (this.started) return;
    this.started = true;
    window.addEventListener('popstate', () => void this.followHash());
    window.addEventListener('hashchange', () => void this.followHash());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.refreshState();
    });
    window.setInterval(() => {
      if (document.visibilityState === 'visible' && this.view.conn === 'open') void this.refreshState();
    }, 30e3);
    try {
      const state = await get<ServerState>('/api/state');
      this.set({ state, progress: state.scan.progress });
      await Promise.all([this.loadRoot(), this.loadJettison()]);
      this.openEvents();
      await this.followHash();
      this.loadInsights();
      this.inspectNow();
    } catch (err) {
      this.set({ bootError: err instanceof Error ? err.message : String(err) });
      window.setTimeout(() => {
        this.started = false;
        this.set({ bootError: null });
        void this.start();
      }, 4000);
    }
  }

  private async refreshState() {
    try {
      const state = await get<ServerState>('/api/state');
      const before = this.snapId;
      this.set({ state: { ...state }, progress: state.scan.progress ?? this.view.progress });
      if (state.snapshot?.id !== before) await this.onSnapshot();
    } catch {
      // the event stream reports a lost connection
    }
  }

  private openEvents() {
    this.events?.close();
    const es = new EventSource('/api/events');
    this.events = es;
    let wasLost = false;
    es.addEventListener('open', () => {
      this.set({ conn: 'open' });
      if (wasLost) void this.refreshState();
      wasLost = false;
    });
    es.addEventListener('error', () => {
      wasLost = true;
      this.set({ conn: es.readyState === EventSource.CLOSED ? 'lost' : 'connecting' });
      if (es.readyState === EventSource.CLOSED) window.setTimeout(() => this.openEvents(), 3000);
    });
    es.addEventListener('scan', (e) => {
      const scan = JSON.parse((e as MessageEvent).data) as ScanInfo;
      const st = this.view.state;
      const was = st?.scan.status;
      if (st) this.set({ state: { ...st, scan }, progress: scan.progress ?? this.view.progress });
      if (was && was !== 'idle' && scan.status === 'idle' && scan.error)
        this.notify({ body: scan.error, type: 'error', id: 'scan' });
    });
    es.addEventListener('progress', (e) => {
      const msg = JSON.parse((e as MessageEvent).data) as { progress: ScanProgress; tree?: RawNode | null };
      this.set({ progress: msg.progress });
      if (msg.tree && !this.view.state?.snapshot) {
        this.tree.graft(msg.tree, DISK_KEY, 0, true);
        this.bump();
      }
    });
    es.addEventListener('snapshot', (e) => {
      const next = JSON.parse((e as MessageEvent).data) as Omit<ServerState, 'local'>;
      const st = this.view.state;
      this.set({ state: { ...next, local: st?.local ?? false } as ServerState });
      void this.onSnapshot();
    });
    es.addEventListener('jettison', (e) => {
      this.set({ jettison: JSON.parse((e as MessageEvent).data) as JettisonView });
    });
  }

  // ------------------------------------------------------------ loading

  private async loadRoot() {
    const res = await get<{ snapshot: string | null; node: RawNode }>('/api/tree', {
      id: 'disk',
      depth: 5,
      min: MIN_FRACTION,
      snap: this.snapId,
    });
    if (!res.node) return;
    this.tree.graft(res.node, DISK_KEY, res.node.size * MIN_FRACTION, Boolean(res.node.live));
    this.bump();
  }

  /** Load a node's children, sized for showing it as the focus. */
  load(node: MNode, depth = 4, fraction = MIN_FRACTION): Promise<void> {
    if (!node.id || node.live) return Promise.resolve();
    const key = node.key;
    const running = this.loading.get(key);
    if (running) return running;
    const snap = this.snapId;
    const p = get<{ snapshot: string | null; node: RawNode }>('/api/tree', { id: node.id, depth, min: fraction, snap })
      .then((res) => {
        if (res.snapshot !== this.snapId) return;
        this.tree.graft(res.node, key, res.node.size * fraction);
        for (const kid of res.node.kids ?? []) this.remember(kid);
        this.bump();
      })
      .catch((err) => this.fail(err))
      .finally(() => this.loading.delete(key));
    this.loading.set(key, p);
    return p;
  }

  /** The map asks for children of tiles big enough to open up. */
  want(nodes: MNode[]) {
    const focus = this.tree.get(this.view.focusKey);
    if (!focus) return;
    for (const n of nodes) {
      if (this.loading.size >= 3) break;
      if (this.loading.has(n.key) || !n.id || n.live) continue;
      const fraction = Math.min(0.2, Math.max(MIN_FRACTION, (MIN_FRACTION * focus.size) / Math.max(1, n.size)));
      void this.load(n, 3, fraction);
    }
  }

  prefetch(key: string) {
    const n = this.tree.get(key);
    if (n && canDive(n) && needsLoad(n) && !this.loading.has(key)) void this.load(n);
  }

  private remember(raw: RawNode & { path?: string }) {
    if (raw.path && raw.id !== undefined) this.paths.set(String(raw.id), raw.path);
  }

  private async loadJettison() {
    try {
      const j = await get<JettisonView & { snapshot: string | null }>('/api/jettison');
      this.set({ jettison: { items: j.items, freed: j.freed, planned: j.planned } });
    } catch (err) {
      this.fail(err);
    }
  }

  loadInsights() {
    const focus = this.tree.get(this.view.focusKey);
    const scope = focus && isScanned(focus) && focus.role !== 'volume' ? focus.id : '';
    if (!this.snapId) {
      this.set({ insights: null, insightsLoading: false });
      return;
    }
    const cached = this.insightCache.get(scope);
    if (cached) {
      this.set({ insights: cached, insightsLoading: false });
      return;
    }
    this.set({ insightsLoading: true });
    const snap = this.snapId;
    get<Insights>('/api/insights', { id: scope || null, snap })
      .then((ins) => {
        if (ins.snapshot !== this.snapId) return;
        for (const list of [ins.top.reclaim, ins.top.review, ins.files, ins.stale]) for (const it of list) this.remember(it);
        this.insightCache.set(scope, ins);
        const now = this.tree.get(this.view.focusKey);
        const nowScope = now && isScanned(now) && now.role !== 'volume' ? now.id : '';
        if (nowScope === scope) this.set({ insights: ins, insightsLoading: false });
      })
      .catch((err) => {
        this.set({ insightsLoading: false });
        this.fail(err);
      });
  }

  private async onSnapshot() {
    this.insightCache.clear();
    this.paths.clear();
    const focusKey = this.view.focusKey;
    const selectedKey = this.view.selectedKey;
    try {
      await this.loadRoot();
      if (focusKey !== DISK_KEY) {
        const ok = await this.goToKey(focusKey, { push: false, select: false });
        if (!ok) this.setFocus(DISK_KEY, { push: false });
      }
      if (selectedKey && !this.tree.get(selectedKey)) this.set({ selectedKey: null });
      this.loadInsights();
      this.inspectNow();
      if (this.view.query) this.runSearch(this.view.query);
      void this.loadJettison();
    } catch (err) {
      this.fail(err);
    }
  }

  private async reloadAll() {
    try {
      const state = await get<ServerState>('/api/state');
      this.set({ state });
      await this.onSnapshot();
    } catch (err) {
      this.fail(err);
    }
  }

  // ------------------------------------------------------------ navigating

  private setFocus(key: string, { push = true, select = null as string | null } = {}) {
    const changed = key !== this.view.focusKey;
    this.set({ focusKey: key, selectedKey: select, hoverKey: null });
    if (push && changed) {
      const hash = keyToHash(key);
      const url = hash ? `#${hash}` : `${location.pathname}${location.search}`;
      history.pushState(null, '', url);
    }
    if (changed) this.loadInsights();
    this.inspectSoon(0);
  }

  /** Open a tile: the map zooms into it. */
  async dive(key: string) {
    const n = this.tree.get(key);
    if (!n) return;
    if (!canDive(n)) {
      this.select(key);
      return;
    }
    const seq = ++this.navSeq;
    if (needsLoad(n)) {
      // Give the children a moment so the map dives into something. Past that
      // it dives anyway and fills in, with the busy line on until they land.
      this.set({ busy: true });
      const p = this.load(n);
      await Promise.race([p, wait(160)]);
      if (seq !== this.navSeq) return;
      void p.then(() => seq === this.navSeq && this.set({ busy: false }));
    } else if (this.view.busy) this.set({ busy: false });
    this.setFocus(key);
  }

  /** Back out one level, or to an ancestor. */
  async up(toKey?: string) {
    const focus = this.tree.get(this.view.focusKey);
    if (!focus) return;
    let target = this.tree.get(toKey ?? parentKeyOf(focus.key));
    // A folder that holds nothing but the one the map came out of shares its
    // tile on the map, so one level up passes it.
    if (!toKey) while (target?.parent && target.key !== DISK_KEY && soleChild(target)) target = target.parent;
    if (!target) return;
    const seq = ++this.navSeq;
    if (needsLoad(target) || target.stub) {
      this.set({ busy: true });
      const p = this.load(target);
      await Promise.race([p, wait(400)]);
      if (seq !== this.navSeq) return;
      void p.then(() => seq === this.navSeq && this.set({ busy: false }));
    } else if (this.view.busy) this.set({ busy: false });
    // Select the folder the map just came out of, as a tile of the new focus.
    let came: MNode | null = this.tree.get(focus.key);
    while (came?.parent && came.parent.key !== target.key) came = came.parent;
    this.setFocus(target.key, { select: came?.parent?.key === target.key ? came.key : null });
  }

  select(key: string | null) {
    if (key === this.view.selectedKey) return;
    this.set({ selectedKey: key });
    this.inspectSoon();
  }

  hover(key: string | null) {
    if (key !== this.view.hoverKey) this.set({ hoverKey: key });
  }

  setTab(tab: Tab) {
    this.set({ tab });
  }

  /** Show a listed item on the map: its folder becomes the focus and the item is selected. */
  async reveal(item: { id: number; name: string }) {
    const seq = ++this.navSeq;
    this.set({ busy: true });
    try {
      const key = await this.keyFor(item.id);
      if (seq !== this.navSeq || !key) return;
      const node = this.tree.get(key);
      const parent = this.tree.get(parentKeyOf(key));
      if (parent && parent.key !== DISK_KEY) {
        if (needsLoad(parent) || !this.tree.get(key) || parent.stub) await this.load(parent);
        if (seq !== this.navSeq) return;
        const shown = this.tree.get(key);
        const p = this.tree.get(parent.key);
        // Too small to see in its folder: open it instead, when it opens.
        if ((!shown || (p && shown.size < p.size * 2e-3)) && shown && canDive(shown)) {
          if (needsLoad(shown)) await this.load(shown);
          if (seq === this.navSeq) this.setFocus(shown.key);
          return;
        }
        this.setFocus(parent.key, { select: key });
      } else if (node) this.setFocus(DISK_KEY, { select: key });
    } catch (err) {
      this.fail(err);
    } finally {
      if (seq === this.navSeq) this.set({ busy: false });
    }
  }

  /** The tree key for a scanned item, adding the folders above it as needed. */
  private async keyFor(id: number): Promise<string | null> {
    const known = this.tree.byId.get(String(id));
    if (known && !known.stub) return known.key;
    const d = await get<Detail>('/api/node', { id, snap: this.snapId });
    if (d.path) this.paths.set(String(id), d.path);
    const chain = d.ancestors ?? [];
    if (!chain.length) return this.tree.byId.get(String(id))?.key ?? null;
    const key = this.tree.ensureChain(String(chain[0].id), [...chain.slice(1), { id, name: d.name }]);
    this.bump();
    return key;
  }

  private async goToKey(key: string, { push = true, select = false } = {}): Promise<boolean> {
    const path = keyToRawPath(key);
    if (!path) return false;
    const seq = ++this.navSeq;
    try {
      const found = await get<{ id: number; path: string }>('/api/find', { path });
      if (seq !== this.navSeq) return false;
      const k = await this.keyFor(found.id);
      const n = k ? this.tree.get(k) : null;
      if (!n || seq !== this.navSeq) return false;
      if (needsLoad(n)) await this.load(n);
      if (seq !== this.navSeq) return false;
      if (select) this.setFocus(parentKeyOf(n.key) ?? DISK_KEY, { push, select: n.key });
      else this.setFocus(n.key, { push });
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return false;
      this.fail(err);
      return false;
    }
  }

  private async followHash() {
    const key = hashToKey(location.hash);
    if (key === this.view.focusKey) return;
    if (key === DISK_KEY) {
      this.setFocus(DISK_KEY, { push: false });
      return;
    }
    const known = this.tree.get(key);
    if (known && !known.stub && !needsLoad(known)) {
      this.setFocus(key, { push: false });
      return;
    }
    const ok = await this.goToKey(key, { push: false });
    if (!ok) {
      this.notify({ body: 'That folder is not on the map any more, so the map shows the whole disk.', id: 'hash' });
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      this.setFocus(DISK_KEY, { push: false });
    }
  }

  // ------------------------------------------------------------ inspector

  private inspectSoon(delay = 90) {
    window.clearTimeout(this.inspectTimer);
    const key = this.view.selectedKey ?? this.view.focusKey;
    const n = this.tree.get(key);
    // Show what the tree knows right away; the server's detail follows.
    if (this.view.inspect?.key !== key) this.set({ inspect: { key, detail: null, loading: Boolean(n?.id), error: null } });
    this.inspectTimer = window.setTimeout(() => this.inspectNow(), delay);
  }

  private inspectNow() {
    const key = this.view.selectedKey ?? this.view.focusKey;
    const n = this.tree.get(key);
    const seq = ++this.inspectSeq;
    if (!n?.id) {
      this.set({ inspect: { key, detail: null, loading: false, error: null } });
      return;
    }
    get<Detail>('/api/node', { id: n.id, snap: isScanned(n) ? this.snapId : null })
      .then((detail) => {
        if (seq !== this.inspectSeq) return;
        if (detail.path) this.paths.set(n.id!, detail.path);
        this.set({ inspect: { key, detail, loading: false, error: null } });
      })
      .catch((err) => {
        if (seq !== this.inspectSeq) return;
        if (err instanceof ApiError && err.status === 409) return void this.reloadAll();
        this.set({ inspect: { key, detail: null, loading: false, error: (err as Error).message } });
      });
  }

  // ------------------------------------------------------------ search

  setQuery(q: string) {
    this.set({ query: q });
    window.clearTimeout(this.searchTimer);
    if (!q.trim()) {
      ++this.searchSeq;
      this.set({ search: null, searching: false });
      return;
    }
    this.set({ searching: true });
    this.searchTimer = window.setTimeout(() => this.runSearch(q), 140);
  }

  private runSearch(q: string) {
    const seq = ++this.searchSeq;
    get<SearchResult>('/api/search', { q: q.trim(), limit: 60, snap: this.snapId })
      .then((res) => {
        if (seq !== this.searchSeq) return;
        for (const it of res.items) this.remember(it);
        this.set({ search: res, searching: false });
      })
      .catch((err) => {
        if (seq !== this.searchSeq) return;
        this.set({ searching: false });
        this.fail(err);
      });
  }

  // ------------------------------------------------------------ actions

  pathOf(id: string | number | null | undefined): string | null {
    return id === null || id === undefined ? null : (this.paths.get(String(id)) ?? null);
  }

  /** Fetch a path ahead of a copy, so the copy can happen inside the click. */
  async ensurePath(id: string): Promise<string | null> {
    const known = this.paths.get(id);
    if (known) return known;
    try {
      const d = await get<Detail>('/api/node', { id, snap: this.snapId });
      if (d.path) this.paths.set(id, d.path);
      return d.path ?? null;
    } catch {
      return null;
    }
  }

  /** Copy an item's path, inside the click when the path is already known. */
  async copyPath(id: string | number) {
    const path = this.pathOf(id) ?? (await this.ensurePath(String(id)));
    if (!path) {
      this.notify({ body: 'Could not find where it is.', type: 'error' });
      return;
    }
    const ok = await copyText(path);
    this.notify(
      ok
        ? { body: `Copied ${path}`, id: 'copy' }
        : { body: 'The browser would not copy it. Select the path in the panel and copy it there.', type: 'error' },
    );
  }

  markedEntry(id: string | null, path?: string | null) {
    const items = this.view.jettison?.items ?? [];
    return items.find((it) => (id !== null && it.id !== null && String(it.id) === id) || (path ? it.path === path : false)) ?? null;
  }

  /** The marked folder this node sits in, when it is not marked itself. */
  markedAround(n: MNode | null): MNode | null {
    for (let p = n?.parent ?? null; p; p = p.parent) if (p.id && this.markedEntry(p.id)) return p;
    return null;
  }

  async mark(id: string | number) {
    try {
      const view = await post<JettisonView>('/api/jettison', { action: 'add', id: Number(id) });
      this.set({ jettison: view });
    } catch (err) {
      this.fail(err, 'Could not mark it.');
    }
  }

  async unmark(path: string) {
    try {
      const view = await post<JettisonView>('/api/jettison', { action: 'remove', path });
      this.set({ jettison: view });
    } catch (err) {
      this.fail(err, 'Could not unmark it.');
    }
  }

  async clearFreed() {
    try {
      const view = await post<JettisonView>('/api/jettison', { action: 'clear' });
      this.set({ jettison: view });
    } catch (err) {
      this.fail(err);
    }
  }

  async revealInFinder(id: string | number) {
    try {
      await post('/api/reveal', { id: Number(id) });
    } catch (err) {
      this.fail(err);
    }
  }

  async scan(mode: 'auto' | 'ask' = 'auto') {
    try {
      const scan = await post<ScanInfo>('/api/scan', { protected: mode });
      const st = this.view.state;
      if (st) this.set({ state: { ...st, scan } });
    } catch (err) {
      this.fail(err, 'Could not start the scan.');
    }
  }

  async stopScan() {
    try {
      await post('/api/scan/stop', {});
    } catch (err) {
      this.fail(err);
    }
  }
}

function wait(ms: number) {
  return new Promise<void>((r) => window.setTimeout(r, ms));
}

// The address bar holds the focus as the names on the way down from a
// volume: #/Data/Users/alex. It survives rescans and reloads.
export function keyToHash(key: string): string {
  if (key === DISK_KEY || !key.startsWith(DISK_KEY + '/')) return '';
  const parts = key.slice(DISK_KEY.length + 1).split('/');
  return '/' + parts.map((p) => encodeURIComponent(p.replace(/^\u0001/, ''))).join('/');
}

export function hashToKey(hash: string): string {
  const raw = hash.replace(/^#/, '');
  if (!raw || raw === '/') return DISK_KEY;
  const parts = raw.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  if (!parts.length) return DISK_KEY;
  return [DISK_KEY, `\u0001${parts[0]}`, ...parts.slice(1)].join('/');
}

/** The scanned path a key names, as the server's /api/find takes it. */
export function keyToRawPath(key: string): string | null {
  if (!isInside(key, DISK_KEY)) return null;
  const [vol, ...rest] = key.slice(DISK_KEY.length + 1).split('/');
  const base = DATA_PATHS[vol.replace(/^\u0001/, '')];
  if (!base) return null;
  return rest.length ? `${base}/${rest.join('/')}` : base;
}

export const store = new Store();

export function useView<T>(select: (v: View) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

export type { Item };
