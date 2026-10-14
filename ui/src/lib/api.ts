// The Spacewalk server's API, typed as server/server.mjs sends it.

export type Tone = 'reclaim' | 'review' | 'neutral';

export interface Kind {
  label: string;
  tone: Tone;
  whole?: boolean;
  blurb: string;
}

export interface ScanProgress {
  elapsed: number;
  files: number;
  dirs: number;
  bytes: number;
  locked: number;
  protected: number;
  current: string | null;
  /** The folder being read, relative to the Data volume. */
  at?: string | null;
  waiting: { path: string; seconds: number }[];
}

export interface ScanInfo {
  status: 'idle' | 'scanning' | 'finishing';
  mode: string | null;
  startedAt: number | null;
  progress: ScanProgress | null;
  error: string | null;
  expected: { bytes: number; files: number; seconds: number } | null;
}

export interface SnapInfo {
  id: string;
  createdAt: number;
  elapsed: number;
  files: number;
  dirs: number;
  bytes: number;
  full: number;
  priv: number;
  linkedBytes: number;
  clonedBytes: number;
  minFile: number;
  locked: number;
  protected: number;
  stalled: number;
  errors: number;
  protectedMode: string;
  access: Record<string, string> | null;
  disk: { size: number; free: number; at: number } | null;
  source: string;
}

export interface ServerState {
  app: 'spacewalk';
  machine: string;
  home: string;
  launchedFrom: string | null;
  kinds: Record<string, Kind>;
  disk: { name: string; size: number; free: number; at: number } | null;
  others: { name: string; size: number; free: number }[];
  snapshot: SnapInfo | null;
  scan: ScanInfo;
  jettison: { count: number; freed: number; planned: number };
  local: boolean;
}

export interface RawNode {
  id?: number | string;
  name: string;
  size: number;
  full?: number;
  priv?: number;
  files?: number;
  dirs?: number;
  flags: number;
  mtime?: number;
  rc?: number;
  rv?: number;
  kind?: string;
  err?: number;
  service?: string | null;
  open?: boolean;
  kids?: RawNode[];
  small?: { count: number; size: number };
  rest?: { count: number; size: number };
  role?: string;
  volume?: string;
  note?: string;
  scanned?: number;
  pending?: boolean;
  live?: boolean;
  /** One past the last id inside this folder; ids in [id, end) are its contents. */
  end?: number;
}

/** One thing in a list: a ranked item, a search hit. */
export interface Item extends RawNode {
  id: number;
  path: string;
}

export interface Unreadable {
  count: number;
  places: { id: number; path: string; count: number }[];
}

export interface Detail extends RawNode {
  path?: string;
  ancestors?: { id: number; name: string }[];
  modified?: number;
  children?: number;
  jettison?: boolean;
  free?: number;
  now?: number | null;
  others?: { name: string; size: number; free: number }[];
  unreadable?: Record<string, Unreadable> | null;
  access?: Record<string, string> | null;
  protectedMode?: string | null;
  launchedFrom?: string | null;
}

export interface Category {
  kind: string;
  label: string;
  tone: Tone;
  blurb: string;
  size: number;
  priv: number;
  count: number;
  items: Item[];
}

export interface Insights {
  snapshot: string | null;
  scope: number | null;
  size: number;
  reclaim: { size: number; priv: number; count: number };
  review: { size: number };
  categories: Category[];
  top: { reclaim: Item[]; review: Item[] };
  files: Item[];
  stale: Item[];
  staleDays: number;
}

export interface JettisonItem {
  path: string;
  name: string;
  size: number;
  kind: string | null;
  addedAt: number;
  id: number | null;
  now: number | null;
  gone: boolean;
}

export interface JettisonView {
  items: JettisonItem[];
  freed: number;
  planned: number;
}

export interface SearchResult {
  snapshot: string | null;
  total: number;
  items: Item[];
}

export const NF = {
  DIR: 1 << 0,
  LOCKED: 1 << 1,
  OTHERFS: 1 << 2,
  HARDLINK: 1 << 3,
  DATALESS: 1 << 4,
  STALLED: 1 << 5,
  PARTIAL: 1 << 6,
  ROOT: 1 << 7,
  CLONE: 1 << 8,
  SHARED: 1 << 9,
  PURGEABLE: 1 << 10,
  GATED: 1 << 11,
  SKIPPED: 1 << 12,
  ASK: 1 << 13,
} as const;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Params = Record<string, string | number | null | undefined>;

function url(path: string, params?: Params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== null && v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

async function read<T>(res: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // an empty or broken answer
  }
  if (!res.ok) {
    const said = body && typeof body === 'object' && 'error' in body ? body.error : null;
    throw new ApiError(res.status, typeof said === 'string' && said ? said : `Spacewalk answered ${res.status}.`);
  }
  return body as T;
}

export async function get<T>(path: string, params?: Params, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url(path, params), { signal, headers: { Accept: 'application/json' } });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'Could not reach Spacewalk. Is it still running?');
  }
  return read<T>(res);
}

export async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Spacewalk': '1', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Could not reach Spacewalk. Is it still running?');
  }
  return read<T>(res);
}
