// The map's geometry: which tiles show at the current focus, where they
// sit, and how their labels fit. Tiles are squarified (Bruls, Huizing and
// van Wijk) and nest while a group has room for a header and children big
// enough to read; past that a folder is one tile, coloured by its heat. A
// folder that holds nothing but one other folder shares that folder's header
// row, so a chain like Users / alex does not use up the nesting.

import { heat, heatRGB, rgb, GRAPHITE, GROUND, type RGB } from '../lib/heat';
import { size as formatSize } from '../lib/format';
import { canDive, soleChild, type MNode } from '../lib/model';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Label {
  /** The name as shown, cut short if it had to be. */
  name: string;
  /** The name broken across lines, when a tall tile reads better that way. */
  lines: string[];
  size: string | null;
  /** Name and size font sizes, px. */
  fs: number;
  ss: number;
  narrow: boolean;
}

export interface Heading {
  name: string;
  size: string | null;
  fs: number;
}

export interface Tile extends Rect {
  key: string;
  /** The folder whose contents the tile shows: the last of a chain. */
  node: MNode;
  /** 1 for the focus's children; 0 for the focus itself, shown whole while its children load. */
  depth: number;
  parent: string | null;
  container: boolean;
  /** Header height, px, for a container. */
  head: number;
  heading: Heading | null;
  /** Where the tile's contents sit: under the header, inside the padding. */
  inner: Rect;
  heat: number;
  fill: RGB;
  label: Label | null;
}

export interface Layout {
  key: string;
  focus: MNode;
  w: number;
  h: number;
  tiles: Tile[];
  /** Every tile by key, and the folders a chain's tile stands for by theirs. */
  byKey: Map<string, Tile>;
  /** Folders big enough to open up on the map whose children are not loaded. */
  wants: MNode[];
}

export const FAMILY = '"Archivo Variable", "Archivo", ui-sans-serif, system-ui, sans-serif';
export const MIN_FS = 10;
export const GUTTER = 1;
/** Baseline to baseline for a name on more than one line, in ems. */
export const LEAD = 1.08;

const HEAD = [0, 20, 16, 14];
const PAD = [0, 2, 1, 1];
const MAX_NEST = 3;
const TRACKING = 0.07; // header caps, in em

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------- text

let measurer: CanvasRenderingContext2D | null = null;
let narrowOK = false;
let trackOK = false;
const widths = new Map<string, number>();

function ctx(): CanvasRenderingContext2D {
  if (!measurer) {
    measurer = document.createElement('canvas').getContext('2d')!;
    narrowOK = 'fontStretch' in measurer;
    trackOK = 'letterSpacing' in measurer;
  }
  return measurer;
}

/** Set a canvas's font the way the map measures it. */
export function setFont(c: CanvasRenderingContext2D, fs: number, weight: number, narrow = false, caps = false) {
  c.font = `${weight} ${fs}px ${FAMILY}`;
  if (narrowOK) c.fontStretch = narrow ? 'condensed' : 'normal';
  if (trackOK) c.letterSpacing = caps ? `${(fs * TRACKING).toFixed(2)}px` : '0px';
}

function measure(text: string, fs: number, weight: number, narrow = false, caps = false): number {
  const key = `${fs}|${weight}|${narrow ? 1 : 0}|${caps ? 1 : 0}|${text}`;
  let w = widths.get(key);
  if (w === undefined) {
    const c = ctx();
    setFont(c, fs, weight, narrow, caps);
    w = c.measureText(text).width;
    if (widths.size > 40000) widths.clear();
    widths.set(key, w);
  }
  return w;
}

/** Forget measurements, after the web font arrives. */
export function resetMeasures() {
  widths.clear();
}

function ellipsize(text: string, room: number, fs: number, weight: number, narrow = false, caps = false): string | null {
  let lo = 1;
  let hi = text.length - 1;
  let best: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = `${text.slice(0, mid).trimEnd()}…`;
    if (measure(t, fs, weight, narrow, caps) <= room) {
      best = t;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best && best.length >= 3 ? best : null;
}

/** Where a name can break across lines: after a dash, an underscore or a
    space, before a dot that is not inside a number, and where one word ends
    and a capitalised one begins, as in SoftwareUpdate. A lone capital, as in
    iPhone or a temp name like clean.uPwt7o, is not a word break. */
function pieces(name: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 1; i < name.length; i++) {
    const c = name[i];
    const b = name[i - 1];
    const after = b === '-' || b === '_' || b === ' ';
    const dot = c === '.' && !(/\d/.test(b) && /\d/.test(name[i + 1] ?? ''));
    const hump = /[a-z]{2}$/.test(name.slice(start, i)) && /^[A-Z][a-z]{2}/.test(name.slice(i, i + 3));
    if ((after || dot || hump) && i - start >= 2) {
      out.push(name.slice(start, i));
      start = i;
    }
  }
  out.push(name.slice(start));
  return out;
}

/** The most even way to set pieces on n lines: the lines, and the widest of them at fs. */
function wrap(parts: string[], n: number, fs: number, narrow: boolean): { lines: string[]; width: number } | null {
  if (parts.length < n || parts.length > 24) return null;
  const line = (a: number, b: number) => parts.slice(a, b).join('').trim();
  let best: { lines: string[]; width: number } | null = null;
  const consider = (lines: string[]) => {
    if (lines.some((l) => !l)) return;
    let width = 0;
    for (const l of lines) width = Math.max(width, measure(l, fs, 700, narrow));
    if (!best || width < best.width) best = { lines, width };
  };
  const end = parts.length;
  if (n === 2) for (let i = 1; i < end; i++) consider([line(0, i), line(i, end)]);
  else for (let i = 1; i < end - 1; i++) for (let j = i + 1; j < end; j++) consider([line(0, i), line(i, j), line(j, end)]);
  return best;
}

// A tile's label: bold name over its size, scaled to the tile. A name that
// is too long for one line is condensed, or broken across two or three lines
// when that keeps it larger, then shrunk, cut short, or left off when it
// cannot be read.
function fitLabel(name: string, sizeText: string | null, w: number, h: number): Label | null {
  const inset = clamp(Math.round(Math.min(w, h) * 0.08), 3, 10);
  const room = w - GUTTER - inset * 2;
  const tall = h - GUTTER - inset * 2;
  if (room < 18 || tall < MIN_FS) return null;
  const top = Math.min(clamp(Math.floor(Math.sqrt(w * h) / 7), MIN_FS, 30), Math.floor(tall));
  if (top < MIN_FS) return null;
  const parts = pieces(name);
  let best: { lines: string[]; fs: number; narrow: boolean; score: number } | null = null;
  for (let n = 1; n <= 3; n++) {
    for (const narrow of narrowOK ? [false, true] : [false]) {
      const set = n === 1 ? { lines: [name], width: measure(name, top, 700, narrow) } : wrap(parts, n, top, narrow);
      if (!set) continue;
      // Text widths grow with the font size, so one measure gives the size that fits.
      let fs = Math.min(top, Math.floor((top * room) / Math.max(1, set.width)), Math.floor(tall / (1 + (n - 1) * LEAD)));
      while (fs >= MIN_FS && set.lines.some((l) => measure(l, fs, 700, narrow) > room)) fs--;
      if (fs < MIN_FS) continue;
      // Plain before condensed, one line before more, unless the other is clearly larger.
      const score = fs * (narrow ? 0.97 : 1) * (1 - 0.12 * (n - 1));
      if (!best || score > best.score) best = { lines: set.lines, fs, narrow, score };
    }
    if (best && best.fs >= top) break;
  }
  let text = name;
  if (!best) {
    const narrow = narrowOK;
    const cut = ellipsize(name, room, MIN_FS, 700, narrow);
    if (!cut) return null;
    text = cut;
    best = { lines: [cut], fs: MIN_FS, narrow, score: 0 };
  }
  const { lines, fs, narrow } = best;
  let size: string | null = null;
  const ss = clamp(Math.round(fs * 0.66), MIN_FS, 20);
  const block = fs * (1 + (lines.length - 1) * LEAD);
  if (sizeText && block + fs * 0.2 + ss <= tall && measure(sizeText, ss, 500, narrow) <= room) size = sizeText;
  return { name: text, lines, size, fs, ss, narrow };
}

/** A container's header: its name in caps, with the folders it holds alone
    after it, and its size when there is room. A long chain loses its start
    first. */
function fitHeading(names: string[], sizeText: string | null, w: number, depth: number): Heading | null {
  const fs = depth <= 1 ? 11 : 10;
  const room = w - GUTTER - (depth <= 1 ? 12 : 8);
  if (room < 22) return null;
  const caps = names.map((s) => s.toUpperCase());
  const sw = sizeText ? 12 + measure(sizeText, fs, 500) : 0;
  for (let from = 0; from < caps.length; from++) {
    const name = `${from ? '… / ' : ''}${caps.slice(from).join(' / ')}`;
    const nw = measure(name, fs, 650, false, true);
    if (sizeText && nw + sw <= room) return { name, size: sizeText, fs };
    if (nw <= room) return { name, size: null, fs };
  }
  const cut = ellipsize(caps[caps.length - 1], room, fs, 650, false, true);
  return cut ? { name: cut, size: null, fs } : null;
}

// ---------------------------------------------------------------- squarify

/** Rects for values (largest first) filling box, keeping each as square as the row allows. */
export function squarify(values: number[], box: Rect): Rect[] {
  const out: Rect[] = new Array(values.length);
  let total = 0;
  for (const v of values) total += v;
  let { x, y, w, h } = box;
  if (!(total > 0) || w <= 0 || h <= 0) {
    for (let i = 0; i < values.length; i++) out[i] = { x, y, w: 0, h: 0 };
    return out;
  }
  const scale = (w * h) / total;
  let i = 0;
  while (i < values.length) {
    const side = Math.min(w, h);
    let sum = 0;
    let lo = Infinity;
    let hi = 0;
    let worst = Infinity;
    let j = i;
    while (j < values.length) {
      const a = values[j] * scale;
      const s = sum + a;
      const nlo = Math.min(lo, a);
      const nhi = Math.max(hi, a);
      const ratio = Math.max((side * side * nhi) / (s * s), (s * s) / (side * side * nlo));
      if (ratio > worst && j > i) break;
      worst = ratio;
      sum = s;
      lo = nlo;
      hi = nhi;
      j++;
    }
    const thick = sum / side;
    let off = 0;
    for (let k = i; k < j; k++) {
      const len = (values[k] * scale) / thick;
      out[k] = w >= h ? { x, y: y + off, w: thick, h: len } : { x: x + off, y, w: len, h: thick };
      off += len;
    }
    if (w >= h) {
      x += thick;
      w = Math.max(0, w - thick);
    } else {
      y += thick;
      h = Math.max(0, h - thick);
    }
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------- tiles

const GROUND_RGB = rgb(GROUND);
const GRAPHITE_RGB = rgb(GRAPHITE);

function fillOf(n: MNode, h: number): RGB {
  switch (n.role) {
    case 'free':
    case 'hidden':
    case 'pending':
      return GROUND_RGB;
    case 'overhead':
      return GRAPHITE_RGB;
    case 'volume':
      return n.id?.startsWith('vol:') && !n.kids ? GRAPHITE_RGB : heatRGB(h);
    default:
      return heatRGB(h);
  }
}

function visibleKids(n: MNode): MNode[] {
  return n.kids ? n.kids.filter((k) => k.size > 0) : [];
}

// Whether a folder can show its children inside its tile.
function nestable(n: MNode): 'yes' | 'load' | 'no' {
  if (n.role === 'more' || n.role === 'file') return 'no';
  const kids = visibleKids(n);
  const ready = kids.length > 0 && !n.partial && !n.stub && !(kids.length === 1 && kids[0].role === 'more');
  if (ready) return 'yes';
  if (!n.live && canDive(n) && (!n.kids || n.partial || n.stub)) return 'load';
  return 'no';
}

/** Lay out the map for a focus in a w by h area. */
export function layoutMap(focus: MNode, w: number, h: number): Layout {
  const tiles: Tile[] = [];
  const byKey = new Map<string, Tile>();
  const wants: { node: MNode; area: number }[] = [];

  const make = (node: MNode, r: Rect, depth: number, parent: string | null): Tile => {
    const h01 = heat(node.size, node.rc, node.rv);
    const tile: Tile = {
      ...r,
      key: node.key,
      node,
      depth,
      parent,
      container: false,
      head: 0,
      heading: null,
      inner: { ...r },
      heat: h01,
      fill: fillOf(node, h01),
      label: null,
    };
    tiles.push(tile);
    byKey.set(tile.key, tile);
    return tile;
  };

  const place = (parent: MNode, box: Rect, depth: number) => {
    const kids = visibleKids(parent);
    const rects = squarify(
      kids.map((k) => k.size),
      box,
    );
    for (let i = 0; i < kids.length; i++) {
      let node = kids[i];
      const r = rects[i];
      if (r.w < 0.75 || r.h < 0.75) continue;
      const roomy = depth <= MAX_NEST && r.w >= 64 && r.h >= HEAD[depth] + 30 && r.w * r.h >= 5600;
      const nest = roomy ? nestable(node) : 'no';
      const chain = [node];
      if (nest === 'yes')
        for (let sole = soleChild(node); sole && nestable(sole) === 'yes'; sole = soleChild(sole)) {
          chain.push(sole);
          node = sole;
        }
      const tile = make(node, r, depth, parent.key);
      for (let k = 0; k < chain.length - 1; k++) byKey.set(chain[k].key, tile);
      if (nest === 'yes') {
        tile.container = true;
        tile.head = HEAD[depth];
        tile.heading = fitHeading(chain.map((n) => n.name), formatSize(node.size), r.w, depth);
        const p = PAD[depth];
        tile.inner = { x: r.x + p, y: r.y + tile.head, w: r.w - 2 * p, h: r.h - tile.head - p };
        place(node, tile.inner, depth + 1);
        continue;
      }
      if (nest === 'load') wants.push({ node, area: r.w * r.h });
      tile.label = fitLabel(node.name, formatSize(node.size), r.w, r.h);
    }
  };

  const box = { x: GUTTER, y: GUTTER, w: Math.max(0, w - GUTTER), h: Math.max(0, h - GUTTER) };
  if (visibleKids(focus).length && !focus.stub) place(focus, box, 1);
  else {
    // Nothing loaded below the focus yet: show it whole, and let its children settle in.
    const t = make(focus, box, 0, null);
    t.label = fitLabel(focus.name, formatSize(focus.size), box.w, box.h);
  }

  wants.sort((a, b) => b.area - a.area);
  return { key: focus.key, focus, w, h, tiles, byKey, wants: wants.map((x) => x.node) };
}

/** The topmost tile under a point. */
export function hitTile(tiles: Tile[], x: number, y: number): Tile | null {
  for (let i = tiles.length - 1; i >= 0; i--) {
    const t = tiles[i];
    if (x >= t.x && y >= t.y && x < t.x + t.w && y < t.y + t.h) return t;
  }
  return null;
}
