// The map: a canvas the engine draws, with the pointer, touch, keyboard and
// context menu handled here, and the card that follows the pointer.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ContextMenu } from '@astryxdesign/core/ContextMenu';
import type { DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import type { Kind } from '../lib/api';
import { share, size } from '../lib/format';
import { DISK_KEY, canDive, isInside, isScanned, parentKeyOf } from '../lib/model';
import { store, useView } from '../lib/store';
import { Peek, titleOf, type PeekHandle } from '../components/Peek';
import { MapEngine, type How } from './engine';
import { FAMILY, layoutMap, resetMeasures, type Layout, type Tile } from './layout';

const NO_KINDS: Record<string, Kind> = {};

type Box = { w: number; h: number; dpr: number };

export function MapCanvas() {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<MapEngine | null>(null);
  const peekRef = useRef<PeekHandle>(null);
  const last = useRef<{ focus: string | null; box: Box | null }>({ focus: null, box: null });
  const ptr = useRef({ down: null as string | null, x: 0, y: 0, dwell: 0 });
  const menuByKeys = useRef(false);

  const [box, setBox] = useState<Box | null>(null);
  const [fonts, setFonts] = useState(0);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [touch, setTouch] = useState(false);
  const [tapped, setTapped] = useState<string | null>(null);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');

  const focusKey = useView((v) => v.focusKey);
  const treeVersion = useView((v) => v.treeVersion);
  const hoverKey = useView((v) => v.hoverKey);
  const selectedKey = useView((v) => v.selectedKey);
  const search = useView((v) => v.search);
  const query = useView((v) => v.query);
  const jettison = useView((v) => v.jettison);
  const scanAt = useView((v) => (v.state && v.state.scan.status !== 'idle' ? (v.progress?.at ?? null) : null));
  const kinds = useView((v) => v.state?.kinds ?? NO_KINDS);
  const local = useView((v) => v.state?.local ?? false);

  // The engine lives as long as the canvas.
  useLayoutEffect(() => {
    const host = hostRef.current!;
    const engine = new MapEngine(canvasRef.current!);
    engineRef.current = engine;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotion = () => (engine.reduced = motion.matches);
    onMotion();
    motion.addEventListener('change', onMotion);
    const measure = () => {
      const r = host.getBoundingClientRect();
      const w = Math.floor(r.width);
      const h = Math.floor(r.height);
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      engine.setSize(w, h, dpr);
      setBox((b) => (b && b.w === w && b.h === h && b.dpr === dpr ? b : { w, h, dpr }));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    measure();
    return () => {
      ro.disconnect();
      motion.removeEventListener('change', onMotion);
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  // Labels are measured in the web font; measure again once it is in.
  useEffect(() => {
    let live = true;
    Promise.allSettled(['700', '650', '500'].map((w) => document.fonts.load(`${w} 16px ${FAMILY}`))).then(() => {
      if (!live) return;
      resetMeasures();
      setFonts((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, []);

  useLayoutEffect(() => {
    const engine = engineRef.current;
    if (!engine || !box || box.w < 2 || box.h < 2) return;
    const focus = store.tree.get(focusKey) ?? store.tree.root;
    if (!focus) return;
    const next = layoutMap(focus, box.w, box.h);
    const prev = last.current;
    let how: How;
    if (prev.focus === null) how = 'intro';
    else if (prev.box !== box) how = 'none';
    else if (prev.focus === next.key) how = 'settle';
    else if (isInside(next.key, prev.focus)) how = 'dive';
    else if (isInside(prev.focus, next.key)) how = 'up';
    else how = 'jump';
    if (prev.focus !== next.key) setTapped(null);
    last.current = { focus: next.key, box };
    engine.setLayout(next, how);
    setLayout(next);
    if (next.wants.length) store.want(next.wants);
  }, [focusKey, treeVersion, box, fonts]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !layout) return;
    const ids = new Set<string>();
    for (const it of jettison?.items ?? []) if (it.id !== null && !it.gone) ids.add(String(it.id));
    const hits = query.trim() && search ? search.items.map((i) => i.id).sort((a, b) => a - b) : null;
    const marked = new Set<string>();
    const lit = hits ? new Set<string>() : null;
    for (const t of layout.tiles) {
      if (!isScanned(t.node)) continue;
      if (ids.has(t.node.id)) marked.add(t.key);
      if (hits && lit) {
        // Ids run in tree order, so a folder holds every id from its own up to its end.
        const lo = Number(t.node.id);
        const hi = t.node.end || lo + 1;
        let a = 0;
        let b = hits.length;
        while (a < b) {
          const m = (a + b) >> 1;
          if (hits[m] < lo) a = m + 1;
          else b = m;
        }
        if (a < hits.length && hits[a] < hi) lit.add(t.key);
      }
    }
    let pulse: string | null = null;
    if (scanAt)
      for (let k: string | null = `${DISK_KEY}/\u0001Data/${scanAt}`; k; k = parentKeyOf(k))
        if (layout.byKey.has(k)) {
          pulse = k;
          break;
        }
    engine.setMarks({ hover: menuKey ? null : hoverKey, selected: selectedKey, marked, lit, pulse });
  }, [layout, hoverKey, selectedKey, jettison, search, query, scanAt, menuKey]);

  // A new card needs its size measured before it can be placed.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host) peekRef.current?.move(ptr.current.x, ptr.current.y, host.clientWidth, host.clientHeight);
  }, [hoverKey]);

  const at = (e: { clientX: number; clientY: number }) => {
    const r = hostRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
  };

  const open = (t: Tile) => {
    if (t.depth === 0) return;
    if (!canDive(t.node)) {
      store.select(t.key);
      return;
    }
    // The card steps aside for the move and comes back with the pointer.
    store.hover(null);
    void store.dive(t.key);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    if (touch) setTouch(false);
    const p = at(e);
    ptr.current.x = p.x;
    ptr.current.y = p.y;
    const key = engineRef.current?.tileAt(p.x, p.y)?.key ?? null;
    if (key !== store.view.hoverKey) {
      store.hover(key);
      window.clearTimeout(ptr.current.dwell);
      // Resting on a folder loads its contents, so opening it is instant.
      if (key) ptr.current.dwell = window.setTimeout(() => store.prefetch(key), 250);
    }
    peekRef.current?.move(p.x, p.y, p.w, p.h);
  };

  const onPointerLeave = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    window.clearTimeout(ptr.current.dwell);
    store.hover(null);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const isTouch = e.pointerType === 'touch';
    if (isTouch !== touch) setTouch(isTouch);
    const p = at(e);
    const t = engineRef.current?.tileAt(p.x, p.y) ?? null;
    ptr.current.down = t?.key ?? null;
    if (t && t.depth > 0) engineRef.current?.pressDown(t.key);
  };

  const onPointerUp = (e: PointerEvent) => {
    engineRef.current?.pressDown(null);
    if (e.button !== 0) return;
    const down = ptr.current.down;
    ptr.current.down = null;
    const p = at(e);
    const t = engineRef.current?.tileAt(p.x, p.y) ?? null;
    if (!t || t.key !== down) return;
    if (e.pointerType === 'touch') {
      // No hover on touch: the first tap shows a tile, the second opens it.
      if (tapped === t.key) open(t);
      else {
        setTapped(t.key);
        store.select(t.depth > 0 ? t.key : null);
      }
      return;
    }
    if (e.altKey) store.select(t.key);
    else open(t);
  };

  const onPointerCancel = () => {
    engineRef.current?.pressDown(null);
    ptr.current.down = null;
  };

  const say = (key: string | null) => {
    const n = store.tree.get(key);
    const focus = store.tree.get(store.view.focusKey);
    if (!n) return;
    const part = focus && n !== focus ? `, ${share(n.size, focus.size)} of ${focus.name}` : '';
    const rc = n.rc > 0 ? `, ${size(n.rc)} safe to delete` : '';
    setAnnounce(`${titleOf(n)}, ${size(n.size)}${part}${rc}`);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!layout || e.metaKey || e.ctrlKey) return;
    const sel = selectedKey ? layout.byKey.get(selectedKey) : null;
    const dirs: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    if (dirs[e.key]) {
      e.preventDefault();
      const next = sel ? step(layout, sel, dirs[e.key]) : layout.tiles.find((t) => t.depth === 1) ?? null;
      if (next) {
        store.select(next.key);
        say(next.key);
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (sel) open(sel);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      void store.up();
    } else if (e.key === 'Escape') {
      if (sel) store.select(null);
      else if (focusKey !== DISK_KEY) void store.up();
    } else if (e.key === 'm' && sel && isScanned(sel.node)) {
      const entry = store.markedEntry(sel.node.id);
      if (entry) void store.unmark(entry.path);
      else if (!store.markedAround(sel.node)) void store.mark(sel.node.id);
    }
  };

  const onMenu = (isOpen: boolean) => {
    if (!isOpen) {
      setMenuKey(null);
      menuByKeys.current = false;
      return;
    }
    if (!menuByKeys.current) {
      // Opened with the pointer, the menu holds focus itself rather than on
      // its first item, so nothing looks chosen before the pointer gets there.
      // The arrow keys still step into the items.
      const redirect = (e: FocusEvent) => {
        const menu = e.target instanceof Element ? e.target.closest<HTMLElement>('.map-menu') : null;
        if (!menu || menu === e.target) return;
        done();
        menu.tabIndex = -1;
        menu.focus({ preventScroll: true });
      };
      const done = () => {
        document.removeEventListener('focusin', redirect, true);
        window.clearTimeout(timer);
      };
      document.addEventListener('focusin', redirect, true);
      const timer = window.setTimeout(done, 250);
    }
    const key = ptr.current.down ?? store.view.hoverKey ?? store.view.selectedKey;
    ptr.current.down = null;
    engineRef.current?.pressDown(null);
    setMenuKey(key ?? '');
    const n = store.tree.get(key);
    if (n && n.key !== store.view.focusKey) store.select(n.key);
    if (n && isScanned(n)) void store.ensurePath(n.id);
  };

  const items = useMemo<DropdownMenuOption[]>(() => {
    const out: DropdownMenuOption[] = [];
    const n = store.tree.get(menuKey);
    if (n && n.key !== focusKey) {
      if (canDive(n)) out.push({ label: 'Open', onClick: () => void store.dive(n.key) });
      if (isScanned(n)) {
        out.push({
          label: 'Reveal in Finder',
          isDisabled: !local,
          onClick: () => void store.revealInFinder(n.id),
        });
        out.push({ label: 'Copy path', onClick: () => void store.copyPath(n.id) });
        const entry = store.markedEntry(n.id);
        const around = store.markedAround(n);
        if (entry) out.push({ label: 'Unmark', onClick: () => void store.unmark(entry.path) });
        else if (around) out.push({ label: `Inside marked ${around.name}`, isDisabled: true });
        else out.push({ label: 'Mark to delete later', onClick: () => void store.mark(n.id) });
      }
    }
    if (focusKey !== DISK_KEY) {
      if (out.length) out.push({ type: 'divider' });
      out.push({ label: 'Up one level', onClick: () => void store.up() });
    }
    if (!out.length) out.push({ label: 'Nothing to do here', isDisabled: true });
    return out;
    // jettison: marks change what the menu offers
  }, [menuKey, focusKey, local, jettison]);

  const focus = store.tree.get(focusKey) ?? store.tree.root;
  const peekNode = menuKey !== null ? null : store.tree.get(touch ? tapped : hoverKey);

  return (
    <div
      className="map-pane"
      // The menu key and Shift-F10 open the menu with no pointer position.
      onContextMenuCapture={(e) => (menuByKeys.current = e.clientX === 0 && e.clientY === 0 && e.detail === 0)}
    >
      <ContextMenu
        items={items}
        onOpenChange={onMenu}
        label="Actions for this item"
        size="sm"
        menuWidth={232}
        className="map-menu"
      >
        <div
          ref={hostRef}
          className="map-host"
          tabIndex={0}
          role="application"
          aria-roledescription="disk map"
          aria-label={focus ? `Map of ${focus.name}, ${size(focus.size)}` : 'Disk map'}
          aria-describedby="map-keys"
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onKeyDown={onKeyDown}
        >
          <canvas ref={canvasRef} className="map-canvas" />
          <Peek
            ref={peekRef}
            node={peekNode}
            focus={focus}
            kinds={kinds}
            touch={touch}
            onOpen={() => tapped && void store.dive(tapped)}
          />
        </div>
      </ContextMenu>
      <p id="map-keys" className="sr-only">
        Arrow keys move between items. Enter opens a folder. Backspace goes up a level. M marks an item to delete later.
      </p>
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}

// The nearest tile in a direction, among the selection's neighbours first.
function step(layout: Layout, from: Tile, [dx, dy]: [number, number]): Tile | null {
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  const pick = (pool: Tile[]) => {
    let best: Tile | null = null;
    let score = Infinity;
    for (const t of pool) {
      const ox = t.x + t.w / 2 - cx;
      const oy = t.y + t.h / 2 - cy;
      const along = ox * dx + oy * dy;
      if (along <= 1) continue;
      const across = Math.abs(ox * dy) + Math.abs(oy * dx);
      const s = along + across * 2;
      if (s < score) {
        score = s;
        best = t;
      }
    }
    return best;
  };
  const siblings = layout.tiles.filter((t) => t.parent === from.parent && t.key !== from.key);
  return (
    pick(siblings) ??
    pick(layout.tiles.filter((t) => t.depth > 0 && t.key !== from.key && !isInside(t.key, from.key) && !isInside(from.key, t.key)))
  );
}
