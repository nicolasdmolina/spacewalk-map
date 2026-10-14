// Draws the map on a canvas and moves it. A change of focus is a camera
// move: the opened tile grows to fill the frame while its neighbours slide
// out past the edges, solid all the way, and its contents come up inside it
// as it grows. Going up runs the same move backwards: the view shrinks into
// its folder's tile, the neighbours slide back in, and folders with no room
// left to show their contents take their own colour back over them. Tiles
// are matched by key across layouts, so anything on screen before and after
// a change travels instead of popping. Where the layout inside a folder
// changed shape, the old boxes stay solid under the new ones until those
// cover them, so the map never shows a hole. Words never overlap: old ones
// leave before new ones arrive. Deeper folders that load while a move is
// under way change where the move ends, not the move: everything keeps its
// course, and what is new or drawn differently changes on its own clock.

import { css, rgb, GROUND, INK, LINE, type RGB } from '../lib/heat';
import { parentKeyOf } from '../lib/model';
import { GUTTER, LEAD, setFont, type Heading, type Label, type Layout, type Rect, type Tile } from './layout';

export type How = 'none' | 'intro' | 'dive' | 'up' | 'jump' | 'settle' | 'fade';

const DURATION: Record<How, number> = { none: 0, intro: 420, dive: 520, up: 440, jump: 300, settle: 360, fade: 240 };

const INK_RGB = rgb(INK);
const GROUND_RGB = rgb(GROUND);
const LINE_RGB = rgb(LINE);
const MUTED = '#9AA0A8';
const SUBHEAD = '#BCC1C7';

const expo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  w: lerp(a.w, b.w, t),
  h: lerp(a.h, b.h, t),
});
/** A name with the end it was cut short at taken off. */
const stem = (s: string) => (s.endsWith('…') ? s.slice(0, -1).trimEnd() : s);
/** Labels that say the same thing on the same lines, though either may be condensed or cut short. */
const sameWords = (a: Label | null, b: Label | null) => {
  if (!a || !b || a.lines.length !== b.lines.length) return false;
  if (a.lines.length > 1) return a.lines.every((l, i) => l === b.lines[i]);
  if (a.name === b.name) return true;
  const x = stem(a.name);
  const y = stem(b.name);
  return (x !== a.name && y.startsWith(x)) || (y !== b.name && x.startsWith(y));
};
const sameHead = (a: Heading | null, b: Heading | null) =>
  !!a && !!b && a.name === b.name && a.size === b.size && a.fs === b.fs;
/** How much a label fitted to fit is scaled when drawn in r. */
const scaleOf = (r: Rect, fit: Rect) =>
  Math.min((r.w - GUTTER) / Math.max(1, fit.w - GUTTER), (r.h - GUTTER) / Math.max(1, fit.h - GUTTER));
const ratio = (a: number, b: number) => Math.min(4, Math.max(0.25, a / Math.max(0.01, b)));

/** How much two boxes cover each other: 1 for the same box, 0 for boxes apart. */
function overlap(a: Rect, b: Rect) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / (a.w * a.h + b.w * b.h - w * h);
}

/** r, moved the way the box from moves to become to. */
function mapRect(r: Rect, from: Rect, to: Rect): Rect {
  const sx = from.w > 0 ? to.w / from.w : 1;
  const sy = from.h > 0 ? to.h / from.h : 1;
  return { x: to.x + (r.x - from.x) * sx, y: to.y + (r.y - from.y) * sy, w: r.w * sx, h: r.h * sy };
}

/** How a tile shows during a move:
    stay: on screen before and after, it travels between the two;
    slide: comes in or goes out past the frame's edge, whole;
    rise: comes up early, over the tile it replaces or inside one that grows;
    cover: comes up once a shrinking view has settled, going up;
    sink: stays whole under its replacement, then goes, from out;
    fade: fades where it is, in a jump or with reduced motion;
    intro: the first view. */
type Show = 'stay' | 'slide' | 'rise' | 'cover' | 'sink' | 'fade' | 'intro';

interface Anim {
  key: string;
  tile: Tile;
  exiting: boolean;
  show: Show;
  /** When a sinking tile starts to go, in progress. */
  out: number;
  r0: Rect;
  r1: Rect;
  a0: number;
  a1: number;
  /** How much of the solid tile shows: 1 for a tile, 0 for a group that shows its contents. */
  f0: number;
  f1: number;
  /** The box the tile's label was fitted to; the label scales with the tile against it. */
  fit: Rect;
  /** A label with the same words before and after keeps showing and changes size
      on the way, from g0 (and gs0 for its size line) to 1. */
  g0: number;
  gs0: number;
  g1: number;
  gs1: number;
  /** Words on a tile coming in arrive once it is there. Changed words on a
      tile that stays arrive after the old ones have gone. */
  late: boolean;
  la0: number;
  la1: number;
  oldLabel: Label | null;
  oldFit: Rect | null;
  oldLabelA: number;
  oldG: number;
  oldGs: number;
  ha0: number;
  ha1: number;
  oldHead: Heading | null;
  oldHeadA: number;
  /** A tile that changed while a move was under way fades, fills and
      changes its words over span from t0, though it moves with the rest. */
  t0?: number;
  span?: number;
}

interface Shown {
  label: Label | null;
  fit: Rect | null;
  a: number;
  g: number;
  gs: number;
}

interface Sample {
  anim: Anim;
  rect: Rect;
  alpha: number;
  fill: number;
  label: Label | null;
  fit: Rect | null;
  labelA: number;
  grow: number;
  growS: number;
  oldLabel: Label | null;
  oldFit: Rect | null;
  oldLabelA: number;
  oldGrow: number;
  oldGrowS: number;
  head: Heading | null;
  headA: number;
  oldHead: Heading | null;
  oldHeadA: number;
}

/** The words a tile shows most of at a moment, for the next move to start from. */
function shownOf(s: Sample): Shown {
  return s.oldLabelA > s.labelA
    ? { label: s.oldLabel, fit: s.oldFit, a: s.oldLabelA, g: s.oldGrow, gs: s.oldGrowS }
    : { label: s.label, fit: s.fit, a: s.labelA, g: s.grow, gs: s.growS };
}

export interface Marks {
  hover: string | null;
  selected: string | null;
  marked: Set<string>;
  /** While searching: the tiles that are or hold a match. */
  lit: Set<string> | null;
  /** The tile the scan is reading now. */
  pulse: string | null;
}

export class MapEngine {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 0;
  private h = 0;
  layout: Layout | null = null;
  private anims: Anim[] = [];
  private byKey = new Map<string, Anim>();
  private start = 0;
  private duration = 0;
  /** When the last tile changing on its own clock is done. */
  private until = 0;
  /** What the move under way started from, to send it on to a fuller layout. */
  private origin: { prev: Map<string, Sample>; old: Layout | null; how: How } | null = null;
  private raf = 0;
  private marks: Marks = { hover: null, selected: null, marked: new Set(), lit: null, pulse: null };
  private press: { key: string; at: number; up: number } | null = null;
  private patterns: { hatch: CanvasPattern; dense: CanvasPattern } | null = null;
  private hasPending = false;
  reduced = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  setSize(w: number, h: number, dpr: number) {
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.patterns = null;
    this.kick();
  }

  setMarks(marks: Marks) {
    this.marks = marks;
    this.kick();
  }

  /** The press before an open: the tile sinks a little under the pointer. */
  pressDown(key: string | null) {
    const now = performance.now();
    if (key) this.press = { key, at: now, up: 0 };
    else if (this.press && !this.press.up) this.press.up = now;
    this.kick();
  }

  /** The tile under a point, as it will be once motion settles. */
  tileAt(x: number, y: number): Tile | null {
    const tiles = this.layout?.tiles ?? [];
    for (let i = tiles.length - 1; i >= 0; i--) {
      const t = tiles[i];
      if (x >= t.x && y >= t.y && x < t.x + t.w && y < t.y + t.h) return t;
    }
    return null;
  }

  /** Where a tile is on screen now. */
  rectOf(key: string): Rect | null {
    const a = this.byKey.get(key);
    if (!a || a.exiting) return null;
    return lerpRect(a.r0, a.r1, this.eased(performance.now()));
  }

  get moving(): boolean {
    return performance.now() < this.until;
  }

  private progress(now: number) {
    return this.duration > 0 ? clamp01((now - this.start) / this.duration) : 1;
  }

  private eased(now: number) {
    return expo(this.progress(now));
  }

  /** A tile at p of the move, which is now. */
  private sample(a: Anim, p: number, now: number): Sample {
    const e = expo(p);
    // Where it is follows the move; how it looks may run on its own clock.
    const q = a.t0 === undefined ? p : clamp01((now - a.t0) / (a.span || 1));
    const eq = a.t0 === undefined ? e : expo(q);
    let alpha: number;
    switch (a.show) {
      case 'slide':
        alpha = a.exiting ? a.a0 : a.a1;
        break;
      case 'rise':
        // Solid by the time what it replaces starts to go.
        alpha = a.a1 * clamp01(eq / 0.8);
        break;
      case 'cover':
        alpha = a.a1 * smooth(clamp01((q - 0.12) / 0.3));
        break;
      case 'sink':
        alpha = a.a0 * (1 - smooth(clamp01((q - a.out) / 0.25)));
        break;
      case 'fade':
        alpha = a.exiting ? a.a0 * (1 - smooth(clamp01((q - 0.5) / 0.3))) : a.a1 * smooth(clamp01(q / 0.5));
        break;
      case 'intro':
        alpha = a.a1 * smooth(clamp01((q - 0.06) / 0.6));
        break;
      default:
        alpha = lerp(a.a0, a.a1, eq);
    }
    // Old words are gone before new ones arrive, so two sets never show at once.
    const leave = 1 - smooth(clamp01(q / 0.25));
    const arrive = smooth(clamp01((q - 0.3) / 0.3));
    const going = a.exiting && a.show !== 'slide';
    return {
      anim: a,
      rect: lerpRect(a.r0, a.r1, e),
      alpha,
      // A folder gives up its colour to show its contents, or takes it back
      // over them, once the move is under way.
      fill: a.f0 === a.f1 ? a.f1 : lerp(a.f0, a.f1, smooth(clamp01((q - 0.12) / 0.3))),
      label: a.tile.label,
      fit: a.fit,
      labelA: a.late ? arrive : going ? a.la0 * leave : lerp(a.la0, a.la1, arrive),
      grow: lerp(a.g0, a.g1, eq),
      growS: lerp(a.gs0, a.gs1, eq),
      oldLabel: a.oldLabel,
      oldFit: a.oldFit,
      oldLabelA: a.oldLabelA * leave,
      oldGrow: a.oldG,
      oldGrowS: a.oldGs,
      head: a.tile.heading,
      headA: a.late ? arrive : going ? a.ha0 * leave : lerp(a.ha0, a.ha1, arrive),
      oldHead: a.oldHead,
      oldHeadA: a.oldHeadA * leave,
    };
  }

  /** Show a new layout, moving there the way how says. */
  setLayout(next: Layout, how: How) {
    const now = performance.now();
    // More of the same view, landing during a move: the move goes on to it.
    if (how === 'settle' && this.origin && now - this.start < this.duration) {
      this.retarget(next, now);
      return;
    }
    const p = this.progress(now);
    const prev = new Map<string, Sample>();
    for (const a of this.anims) {
      const s = this.sample(a, p, now);
      if (s.alpha > 0.01) prev.set(a.key, s);
    }
    const old = this.layout;
    this.layout = next;
    if (!prev.size && how !== 'none') how = 'intro';
    // With reduced motion nothing travels: the old view fades out where it
    // is and the new one fades in over it.
    if (this.reduced && how !== 'none') how = how === 'settle' ? 'none' : 'fade';
    const { anims, exits } = plan(prev, old, next, how);
    this.origin = how === 'none' || how === 'settle' ? null : { prev, old, how };
    this.anims = [...exits, ...anims];
    this.byKey = new Map(anims.map((a) => [a.key, a]));
    this.start = now;
    this.duration = DURATION[how];
    this.until = now + this.duration;
    this.hasPending = next.tiles.some((t) => t.node.role === 'pending');
    this.kick();
  }

  /** Sends the move under way on to next, a fuller layout of the same view,
      without starting it over. Tiles that look the same keep their course;
      new ones come up, changed ones change and ones next has no place for
      go, each over a settle's time from how it looks now. */
  private retarget(next: Layout, now: number) {
    const { prev, old, how } = this.origin!;
    const p = this.progress(now);
    const e = expo(p);
    const span = DURATION.settle;
    const live = new Map(this.byKey);
    const anims = plan(prev, old, next, how).anims.map((a) => {
      const c = live.get(a.key);
      // One the fuller layout puts somewhere else or paints differently
      // goes the way it was going, and its new self comes up over it.
      if (!c || overlap(c.r1, a.r1) < 0.5 || !samePaint(c.tile, a.tile, Math.max(c.f0, c.f1, a.f1))) return restyle(a, null, now, span);
      live.delete(a.key);
      // From where it is now, on to where the fuller layout puts it.
      const s = this.sample(c, p, now);
      const r0 = startFor(s.rect, a.r1, e);
      if (sameLook(c.tile, a.tile) && sameBox(c.r1, a.r1)) return { ...c, tile: a.tile, r0 };
      return { ...restyle(a, s, now, span), r0 };
    });
    const byKey = new Map(anims.map((a) => [a.key, a]));
    // What goes now stays drawn just over its folder, so it neither jumps
    // under it nor covers what comes up in its place.
    const going = new Map<string, Anim[]>();
    for (const c of live.values()) {
      const s = this.sample(c, p, now);
      if (s.alpha <= 0.01) continue;
      let k = c.tile.parent;
      while (k && !byKey.has(k)) k = parentKeyOf(k);
      going.set(k ?? '', [...(going.get(k ?? '') ?? []), { ...exitOf(s, c.r0, c.r1, 'sink', 0.24), t0: now, span }]);
    }
    const drawn: Anim[] = [...this.anims.filter((a) => a.exiting), ...(going.get('') ?? [])];
    for (const a of anims) drawn.push(a, ...(going.get(a.key) ?? []));
    this.layout = next;
    this.anims = drawn;
    this.byKey = byKey;
    this.until = Math.max(this.until, now + span);
    this.hasPending = next.tiles.some((t) => t.node.role === 'pending');
    this.kick();
  }

  kick() {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    this.draw(now);
    const pressing = this.press && (!this.press.up || now - this.press.up < 160);
    if (!this.press?.up && this.press && now - this.press.at > 1200) this.press = null;
    if (this.press?.up && now - this.press.up >= 160) this.press = null;
    if (now < this.until || pressing || this.marks.pulse || (this.hasPending && !this.reduced)) this.kick();
  };

  private makePatterns() {
    const make = (size: number, paint: (c: CanvasRenderingContext2D) => void) => {
      const c = document.createElement('canvas');
      c.width = c.height = Math.round(size * this.dpr);
      const g = c.getContext('2d')!;
      g.scale(this.dpr, this.dpr);
      paint(g);
      const pat = this.ctx.createPattern(c, 'repeat')!;
      // Drawn one pattern pixel to one screen pixel, so the rules stay crisp.
      pat.setTransform(new DOMMatrix().scale(1 / this.dpr));
      return pat;
    };
    // Hidden and unscanned space: thin diagonal rule, the drafting mark for "not shown".
    const hatch = make(7, (g) => {
      g.strokeStyle = css(LINE_RGB);
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(-1, 8);
      g.lineTo(8, -1);
      g.moveTo(-1, 1);
      g.lineTo(1, -1);
      g.moveTo(6, 8);
      g.lineTo(8, 6);
      g.stroke();
    });
    // Many small items: fine vertical rules, a tile made of slivers.
    const dense = make(3, (g) => {
      g.fillStyle = css(GROUND_RGB, 0.32);
      g.fillRect(0, 0, 1, 3);
    });
    this.patterns = { hatch, dense };
  }

  private draw(now: number) {
    const { ctx, dpr } = this;
    if (!this.patterns) this.makePatterns();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = GROUND;
    ctx.fillRect(0, 0, this.w, this.h);
    const p = this.progress(now);
    const moving = now < this.until;
    for (const a of this.anims) {
      const s = this.sample(a, p, now);
      if (s.alpha > 0.003) this.drawTile(s, now, moving);
    }
    if (!moving) this.anims = this.anims.filter((a) => !a.exiting);
    ctx.globalAlpha = 1;
    this.drawMarks(now);
  }

  private snap(v: number) {
    return Math.round(v * this.dpr) / this.dpr;
  }

  private box(r: Rect) {
    const x0 = this.snap(r.x);
    const y0 = this.snap(r.y);
    const x1 = this.snap(r.x + r.w) - GUTTER;
    const y1 = this.snap(r.y + r.h) - GUTTER;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  private dim(t: Tile) {
    const lit = this.marks.lit;
    return !lit || lit.has(t.key) ? 1 : 0.24;
  }

  private drawTile(s: Sample, now: number, moving: boolean) {
    const { ctx } = this;
    const t = s.anim.tile;
    const b = this.box(s.rect);
    if (b.w <= 0 || b.h <= 0) return;
    const dim = this.dim(t);
    const alpha = s.alpha * dim;
    if (s.fill > 0.003) {
      ctx.globalAlpha = alpha * s.fill;
      this.paintFill(t, b, now);
    }
    if (s.oldHead && s.oldHeadA > 0.01) {
      ctx.globalAlpha = alpha * s.oldHeadA;
      this.paintHeading(t, s.oldHead, b, moving);
    }
    if (s.head && s.headA > 0.01) {
      ctx.globalAlpha = alpha * s.headA;
      this.paintHeading(t, s.head, b, moving);
    }
    if (s.fill <= 0.02) return;
    const words = alpha * Math.min(1, s.fill * 1.5);
    if (s.oldLabel && s.oldFit && s.oldLabelA > 0.01) {
      ctx.globalAlpha = words * s.oldLabelA;
      this.paintLabel(t, s.oldLabel, s.oldFit, b, moving, s.oldGrow, s.oldGrowS);
    }
    if (s.label && s.fit && s.labelA > 0.01) {
      ctx.globalAlpha = words * s.labelA;
      this.paintLabel(t, s.label, s.fit, b, moving, s.grow, s.growS);
    }
  }

  private paintFill(t: Tile, b: Rect, now: number) {
    const { ctx } = this;
    const role = t.node.role;
    if (role === 'free') {
      ctx.strokeStyle = css(LINE_RGB);
      ctx.lineWidth = 1;
      if (b.w > 2 && b.h > 2) ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
      return;
    }
    ctx.fillStyle = css(t.fill);
    ctx.fillRect(b.x, b.y, b.w, b.h);
    if (role === 'hidden' || role === 'pending') {
      const pat = this.patterns!.hatch;
      // Space still to scan drifts, so it reads as work under way.
      if (role === 'pending' && !this.reduced) pat.setTransform(new DOMMatrix().translate((now / 90) % 7, 0).scale(1 / this.dpr));
      ctx.fillStyle = pat;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      if (role === 'pending') pat.setTransform(new DOMMatrix().scale(1 / this.dpr));
    } else if (role === 'more' && b.w > 6) {
      ctx.fillStyle = this.patterns!.dense;
      ctx.fillRect(b.x, b.y, b.w, b.h);
    }
  }

  private paintHeading(t: Tile, head: Heading, b: Rect, moving: boolean) {
    const { ctx } = this;
    const hh = t.head || (t.depth <= 1 ? 20 : 16);
    const pad = t.depth <= 1 ? 6 : 4;
    if (moving) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(b.x, b.y, b.w, hh);
      ctx.clip();
    }
    const base = b.y + hh / 2 + head.fs * 0.36;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    setFont(ctx, head.fs, 650, false, true);
    ctx.fillStyle = t.depth <= 1 ? INK : SUBHEAD;
    ctx.fillText(head.name, b.x + pad, base);
    if (head.size) {
      ctx.textAlign = 'right';
      setFont(ctx, head.fs, 500);
      ctx.fillStyle = MUTED;
      ctx.fillText(head.size, b.x + b.w - pad, base);
    }
    if (moving) ctx.restore();
  }

  private paintLabel(t: Tile, l: Label, fit: Rect, b: Rect, moving: boolean, grow = 1, growS = 1) {
    const { ctx } = this;
    const k = Math.min(b.w / Math.max(1, fit.w - GUTTER), b.h / Math.max(1, fit.h - GUTTER));
    const m = k * grow;
    const ms = k * growS;
    const fs = l.fs * m;
    if (fs < 5) return;
    const ss = l.ss * ms;
    const quiet = t.node.role === 'free' || t.node.role === 'hidden' || t.node.role === 'pending';
    if (moving) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(b.x, b.y, b.w, b.h);
      ctx.clip();
    }
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const capN = fs * 0.72;
    const capS = ss * 0.72;
    const gap = l.size ? fs * 0.36 : 0;
    const pitch = fs * LEAD;
    const last = (l.lines.length - 1) * pitch;
    const top = cy - (capN + last + (l.size ? gap + capS : 0)) / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    // Words over the hatching get a ground-coloured edge to sit on.
    const edge = quiet ? Math.max(3, fs * 0.28) : 0;
    if (quiet) {
      ctx.lineJoin = 'round';
      ctx.strokeStyle = GROUND;
    }
    ctx.fillStyle = t.node.role === 'free' ? MUTED : INK;
    l.lines.forEach((line, i) => this.words(line, l.fs, 700, l.narrow, cx, top + capN + i * pitch, m, edge));
    if (l.size) {
      ctx.fillStyle = quiet ? MUTED : INK;
      this.words(l.size, l.ss, 500, l.narrow, cx, top + capN + last + gap + capS, ms, edge);
    }
    if (moving) ctx.restore();
  }

  /** Text set at the size it was fitted at and scaled into place, so a label
      in motion keeps one font and its shaping is reused frame to frame. */
  private words(text: string, fs: number, weight: number, narrow: boolean, x: number, y: number, scale: number, edge: number) {
    const { ctx, dpr } = this;
    setFont(ctx, fs, weight, narrow);
    const scaled = Math.abs(scale - 1) > 0.001;
    if (scaled) {
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * x, dpr * y);
      x = 0;
      y = 0;
    }
    if (edge) {
      ctx.lineWidth = edge / scale;
      ctx.strokeText(text, x, y);
    }
    ctx.fillText(text, x, y);
    if (scaled) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private current(key: string | null, now: number): { tile: Tile; b: Rect } | null {
    if (!key) return null;
    // A folder in a chain shows as the chain's tile.
    const a = this.byKey.get(key) ?? this.byKey.get(this.layout?.byKey.get(key)?.key ?? '');
    if (!a) return null;
    const b = this.box(lerpRect(a.r0, a.r1, this.eased(now)));
    return b.w > 0 && b.h > 0 ? { tile: a.tile, b } : null;
  }

  private drawMarks(now: number) {
    const { ctx } = this;
    const m = this.marks;
    ctx.globalAlpha = 1;

    for (const key of m.marked) {
      const c = this.current(key, now);
      if (!c || c.b.w < 10 || c.b.h < 10) continue;
      const { b } = c;
      const s = Math.round(Math.max(7, Math.min(16, Math.min(b.w, b.h) * 0.2)));
      const x1 = b.x + b.w;
      // A folded corner: the corner turned down, so its back shows.
      ctx.fillStyle = GROUND;
      ctx.beginPath();
      ctx.moveTo(x1 - s, b.y);
      ctx.lineTo(x1, b.y);
      ctx.lineTo(x1, b.y + s);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.moveTo(x1 - s, b.y);
      ctx.lineTo(x1 - s, b.y + s);
      ctx.lineTo(x1, b.y + s);
      ctx.closePath();
      ctx.fill();
    }

    const pulse = this.current(m.pulse, now);
    if (pulse) {
      const k = 0.5 + 0.5 * Math.sin(now / 420);
      ctx.strokeStyle = css(INK_RGB, 0.25 + 0.5 * k);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(pulse.b.x + 0.75, pulse.b.y + 0.75, pulse.b.w - 1.5, pulse.b.h - 1.5);
    }

    if (this.press) {
      const c = this.current(this.press.key, now);
      if (c && c.b.w > 8 && c.b.h > 8) {
        const down = clamp01((now - this.press.at) / 90);
        const k = this.press.up ? down * (1 - clamp01((now - this.press.up) / 160)) : down;
        const inset = Math.min(3, Math.max(1, Math.min(c.b.w, c.b.h) * 0.015)) * expo(k);
        ctx.strokeStyle = GROUND;
        ctx.lineWidth = inset * 2;
        ctx.strokeRect(c.b.x, c.b.y, c.b.w, c.b.h);
        ctx.fillStyle = css(GROUND_RGB, 0.14 * k);
        ctx.fillRect(c.b.x, c.b.y, c.b.w, c.b.h);
      }
    }

    const hover = this.current(m.hover, now);
    if (hover) {
      const parent = this.current(hover.tile.parent, now);
      if (parent && parent.tile.container) {
        ctx.strokeStyle = css(INK_RGB, 0.32);
        ctx.lineWidth = 1;
        ctx.strokeRect(parent.b.x + 0.5, parent.b.y + 0.5, parent.b.w - 1, parent.b.h - 1);
      }
      ring(ctx, hover.b, 2, INK_RGB, 1);
    }

    const sel = this.current(m.selected, now);
    if (sel) {
      ring(ctx, sel.b, 2, INK_RGB, 1);
      if (sel.b.w > 14 && sel.b.h > 14) ring(ctx, { x: sel.b.x + 4, y: sel.b.y + 4, w: sel.b.w - 8, h: sel.b.h - 8 }, 1, INK_RGB, 1);
    }
  }
}

const sameBox = (a: Rect, b: Rect) =>
  Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.w - b.w) < 0.01 && Math.abs(a.h - b.h) < 0.01;

/** The start that puts a box at r when it is e of the way to r1. */
function startFor(r: Rect, r1: Rect, e: number): Rect {
  const k = 1 / Math.max(1e-3, 1 - e);
  return { x: (r.x - e * r1.x) * k, y: (r.y - e * r1.y) * k, w: (r.w - e * r1.w) * k, h: (r.h - e * r1.h) * k };
}

/** Two tiles in the same colour and pattern, or showing so little of
    either (fill is the most of it on screen) that it makes no difference. */
function samePaint(a: Tile, b: Tile, fill: number) {
  if (fill < 0.01) return true;
  return a.node.role === b.node.role && a.fill.every((v, i) => Math.abs(v - b.fill[i]) < 0.5);
}

/** Two tiles that draw the same: the same kind of box with the same words. */
function sameLook(a: Tile, b: Tile) {
  const label = (l: Label | null) => (l ? `${l.lines.join('\n')}|${l.size}|${l.fs}|${l.ss}|${l.narrow}` : '');
  const head = (h: Heading | null) => (h ? `${h.name}|${h.size}|${h.fs}` : '');
  return a.container === b.container && label(a.label) === label(b.label) && head(a.heading) === head(b.heading);
}

/** The tiles of a move from the view sampled in prev, laid out as old, to
    next: those next shows, and those on their way out. */
function plan(prev: Map<string, Sample>, old: Layout | null, next: Layout, how: How): { anims: Anim[]; exits: Anim[] } {
  const prevKey = old?.key ?? null;
  const fade = how === 'fade';
  const camera = how === 'dive' || how === 'up' || how === 'settle';

  const full: Rect = { x: GUTTER, y: GUTTER, w: Math.max(0, next.w - GUTTER), h: Math.max(0, next.h - GUTTER) };
  /** Wholly past the frame's edge, which hides a tile on its way in or out. */
  const outside = (r: Rect) => r.x >= next.w - 0.5 || r.y >= next.h - 0.5 || r.x + r.w <= 0.5 || r.y + r.h <= 0.5;
  // A folder that shared a chain's tile is found under that tile's key.
  const oldKey = (k: string) => old?.byKey.get(k)?.key ?? k;
  /** Where a folder's contents are on screen as the move begins. */
  const aRect = (k: string): Rect | null => {
    const s = prev.get(oldKey(k));
    if (s) return mapRect(s.anim.tile.inner, s.anim.tile, s.rect);
    return k === prevKey ? full : null;
  };
  /** Where a folder's contents sit in the new layout. */
  const bRect = (k: string): Rect | null => next.byKey.get(k)?.inner ?? (k === next.key ? full : null);
  // Tiles on screen before and after that go straight from one box to the other.
  const travels = new Set<string>();
  /** The nearest folder at or above k whose move the things inside it can follow. */
  const common = (k: string | null): string | null => {
    for (let at = k; at; at = parentKeyOf(at)) {
      if (!aRect(at) || !bRect(at)) continue;
      // A folder with a tile before and after leads its contents only if
      // that same tile travels.
      const ak = oldKey(at);
      const bk = next.byKey.get(at)?.key;
      if (prev.has(ak) && bk && !(ak === bk && travels.has(bk))) continue;
      return at;
    }
    return null;
  };

  // The camera: a box that holds the same things before and after.
  let pa: Rect = full;
  let pb: Rect = full;
  if (how === 'dive') {
    for (let k: string | null = next.key; k; k = parentKeyOf(k)) {
      const r = aRect(k);
      if (r) {
        pa = r;
        break;
      }
    }
  } else if (how === 'up' && prevKey) {
    for (let k: string | null = prevKey; k; k = parentKeyOf(k)) {
      const r = bRect(k);
      if (r) {
        pb = r;
        break;
      }
    }
  }
  // Going up, what the view replaces stays until the folders it shrinks
  // into have taken their colour back.
  const out = how === 'up' ? 0.45 : 0.24;

  const anims: Anim[] = [];
  const exits: Anim[] = [];
  // Parents come before their contents, so each tile is judged against a
  // folder that has already been judged.
  for (const t of next.tiles) {
    let s = fade || how === 'none' ? undefined : prev.get(t.key);
    if (s && how !== 'intro') {
      // A tile travels only if it lands about where the move would carry
      // it anyway. When the layout inside a folder changes shape, its
      // boxes would cross each other on the way, so the old one leaves
      // with the move and the new one comes up over it. The same goes for
      // a tile whose colour or pattern changed, so it never switches at a stroke.
      const k = common(t.parent);
      const carried = k ? mapRect(s.rect, aRect(k)!, bRect(k)!) : mapRect(s.rect, pa, pb);
      if (overlap(carried, t) >= 0.5 && samePaint(s.anim.tile, t, Math.max(s.fill, t.container ? 0 : 1))) travels.add(t.key);
      else s = undefined;
    }
    const f1 = t.container ? 0 : 1;
    let r0: Rect;
    let a0: number;
    let f0: number;
    let show: Show;
    if (how === 'none') {
      r0 = t;
      a0 = 1;
      f0 = f1;
      show = 'stay';
    } else if (s && how !== 'intro') {
      r0 = s.rect;
      a0 = Math.max(s.alpha, 0.001);
      f0 = s.fill;
      show = 'stay';
    } else if (camera) {
      const k = common(t.parent);
      r0 = k ? mapRect(t, bRect(k)!, aRect(k)!) : mapRect(t, pb, pa);
      a0 = 0;
      f0 = f1;
      show = outside(r0) ? 'slide' : how === 'up' ? 'cover' : 'rise';
    } else {
      r0 = how === 'intro' ? shrink(t, 0.985) : t;
      a0 = 0;
      f0 = f1;
      show = how === 'intro' ? 'intro' : 'fade';
    }
    const a: Anim = {
      key: t.key,
      tile: t,
      exiting: false,
      show,
      out,
      r0,
      r1: t,
      a0,
      a1: 1,
      f0,
      f1,
      fit: t,
      g0: 1,
      gs0: 1,
      g1: 1,
      gs1: 1,
      // A tile sliding in from past the edge brings its words with it.
      late: how !== 'none' && show !== 'slide',
      la0: 1,
      la1: 1,
      oldLabel: null,
      oldFit: null,
      oldLabelA: 0,
      oldG: 1,
      oldGs: 1,
      ha0: 1,
      ha1: 1,
      oldHead: null,
      oldHeadA: 0,
    };
    if (s && how !== 'none' && how !== 'intro') carryWords(a, s);
    anims.push(a);
  }
  if (how !== 'none') {
    for (const s of prev.values()) {
      if (travels.has(s.anim.key)) continue;
      let r1: Rect = s.rect;
      if (camera) {
        const k = common(s.anim.tile.parent);
        r1 = k ? mapRect(s.rect, aRect(k)!, bRect(k)!) : mapRect(s.rect, pa, pb);
      }
      // Bound past the edge a tile on its way out stays whole; inside the
      // frame it stays under the tile that replaces it until that one is solid.
      exits.push(exitOf(s, s.rect, r1, !camera ? 'fade' : outside(r1) ? 'slide' : 'sink', out));
    }
  }
  return { anims, exits };
}

/** Starts a's words from those s shows: the same words stay and change size
    on the way; different ones leave before a's arrive. */
function carryWords(a: Anim, s: Sample) {
  const t = a.tile;
  a.late = false;
  const was = shownOf(s);
  if (was.label && was.fit && sameWords(was.label, t.label)) {
    // The same words: the new label starts at the size the old one was
    // drawn at and grows or shrinks to fit the tile. A size line that
    // was not there before scales with the name.
    const k0 = scaleOf(s.rect, was.fit);
    const k1 = scaleOf(s.rect, t);
    a.g0 = ratio(was.label.fs * k0 * was.g, t.label!.fs * k1);
    a.gs0 = was.label.size ? ratio(was.label.ss * k0 * was.gs, t.label!.ss * k1) : a.g0;
    a.la0 = was.a;
  } else {
    a.la0 = 0;
    a.oldLabel = was.label;
    a.oldFit = was.fit;
    a.oldLabelA = was.label ? was.a : 0;
    a.oldG = was.g;
    a.oldGs = was.gs;
  }
  const head = s.oldHeadA > s.headA ? s.oldHead : s.head;
  const headA = Math.max(s.oldHeadA, s.headA);
  if (sameHead(head, t.heading)) a.ha0 = headA;
  else {
    a.ha0 = 0;
    a.oldHead = head;
    a.oldHeadA = head ? headA : 0;
  }
}

/** The tile s shows, on its way out from r0 to r1, keeping what it shows. */
function exitOf(s: Sample, r0: Rect, r1: Rect, show: Show, out: number): Anim {
  const was = shownOf(s);
  const head = s.oldHeadA > s.headA ? s.oldHead : s.head;
  const headA = Math.max(s.oldHeadA, s.headA);
  return {
    key: s.anim.key,
    tile: { ...s.anim.tile, label: was.label, heading: head },
    exiting: true,
    show,
    out,
    r0,
    r1,
    a0: s.alpha,
    a1: 0,
    f0: s.fill,
    f1: s.fill,
    fit: was.fit ?? s.rect,
    g0: was.g,
    gs0: was.gs,
    g1: was.g,
    gs1: was.gs,
    late: false,
    la0: was.a,
    la1: was.a,
    oldLabel: null,
    oldFit: null,
    oldLabelA: 0,
    oldG: 1,
    oldGs: 1,
    ha0: headA,
    ha1: headA,
    oldHead: null,
    oldHeadA: 0,
  };
}

/** a, changing over span from now: from how s shows it, or coming up where
    it is if it was not on screen. */
function restyle(a: Anim, s: Sample | null, now: number, span: number): Anim {
  const r: Anim = {
    ...a,
    t0: now,
    span,
    a0: 0,
    f0: a.f1,
    g0: 1,
    gs0: 1,
    la0: 1,
    ha0: 1,
    oldLabel: null,
    oldFit: null,
    oldLabelA: 0,
    oldHead: null,
    oldHeadA: 0,
  };
  if (!s) {
    // Too late to come in with the rest, it comes up where it is.
    r.show = 'rise';
    r.late = true;
    return r;
  }
  r.show = 'stay';
  r.a0 = Math.max(s.alpha, 0.001);
  r.f0 = s.fill;
  carryWords(r, s);
  return r;
}

function ring(ctx: CanvasRenderingContext2D, b: Rect, width: number, color: RGB, alpha: number) {
  if (b.w <= width * 2 || b.h <= width * 2) return;
  ctx.strokeStyle = css(color, alpha);
  ctx.lineWidth = width;
  ctx.strokeRect(b.x + width / 2, b.y + width / 2, b.w - width, b.h - width);
}

function shrink(r: Rect, k: number): Rect {
  return { x: r.x + (r.w * (1 - k)) / 2, y: r.y + (r.h * (1 - k)) / 2, w: r.w * k, h: r.h * k };
}

