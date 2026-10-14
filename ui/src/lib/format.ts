// Numbers, sizes, dates and paths as Spacewalk writes them. Sizes use the
// decimal units Finder and diskutil use, so the numbers match theirs.

const UNITS = ['KB', 'MB', 'GB', 'TB', 'PB'];

export function sizeParts(n: number): { value: string; unit: string } {
  if (!Number.isFinite(n) || n <= 0) return { value: '0', unit: 'bytes' };
  if (n < 1000) return { value: String(Math.round(n)), unit: n === 1 ? 'byte' : 'bytes' };
  let v = n / 1000;
  let u = 0;
  while (v >= 999.5 && u < UNITS.length - 1) {
    v /= 1000;
    u++;
  }
  return { value: v >= 99.95 ? String(Math.round(v)) : v.toFixed(1), unit: UNITS[u] };
}

export function size(n: number): string {
  const p = sizeParts(n);
  return `${p.value} ${p.unit}`;
}

export function count(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function compact(n: number): string {
  if (n < 1e3) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}K`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

/** How long ago a moment was, from milliseconds since 1970. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 45) return `${d} day${d === 1 ? '' : 's'} ago`;
  const mo = Math.round(d / 30.44);
  if (mo < 18) return `${mo} month${mo === 1 ? '' : 's'} ago`;
  const y = Math.round(d / 365.25);
  return `${y} year${y === 1 ? '' : 's'} ago`;
}

export function share(part: number, whole: number): string {
  if (!whole || part <= 0) return '0%';
  const p = (part / whole) * 100;
  if (p >= 99.5) return '100%';
  if (p < 0.1) return 'under 0.1%';
  return p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
}

/** A path with the home folder as ~ and long middles cut, keeping the ends that identify it. */
export function shortPath(path: string, home: string | null, max = 46): string {
  let p = path;
  if (home && (p === home || p.startsWith(home + '/'))) p = '~' + p.slice(home.length);
  if (p.length <= max) return p;
  const parts = p.split('/');
  const head = parts[0] === '' ? '/' + parts[1] : parts[0];
  let tail = parts[parts.length - 1];
  for (let i = parts.length - 2; i > 1; i--) {
    const next = parts[i] + '/' + tail;
    if (head.length + next.length + 3 > max) break;
    tail = next;
  }
  const out = `${head}/…/${tail}`;
  return out.length < p.length ? out : p;
}

/** The folder a path sits in. */
export function parentPath(path: string): string {
  const at = path.lastIndexOf('/');
  return at <= 0 ? '/' : path.slice(0, at);
}
