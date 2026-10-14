// What the selection is, or the focus when nothing is selected: its size and
// share, how much can go, where it lives, and what to do about it. Parts of
// the disk the scan does not cover explain themselves instead.

import type { ReactNode } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import type { Detail, Kind, SnapInfo, Unreadable } from '../lib/api';
import { ago, count, plural, share, shortPath, size, sizeParts } from '../lib/format';
import { DISK_KEY, canDive, isScanned, type MNode } from '../lib/model';
import { store, useView } from '../lib/store';
import { HeatBar } from './HeatBar';
import { MarkIcon, MarkedIcon, RescanIcon } from './icons';
import { titleOf } from './Peek';
import { Settle } from './Settle';

const NO_KINDS: Record<string, Kind> = {};

const ROLE_LINE: Partial<Record<MNode['role'], string>> = {
  disk: 'Disk',
  volume: 'Volume',
  dir: 'Folder',
  file: 'File',
  free: 'Free space',
  overhead: 'File system',
  hidden: 'Not seen by the scan',
  pending: 'Still scanning',
  more: 'Small items',
};

export function Inspector() {
  const inspect = useView((v) => v.inspect);
  const focusKey = useView((v) => v.focusKey);
  useView((v) => v.treeVersion);
  useView((v) => v.jettison);
  const kinds = useView((v) => v.state?.kinds ?? NO_KINDS);
  const home = useView((v) => v.state?.home ?? null);
  const local = useView((v) => v.state?.local ?? false);
  const others = useView((v) => v.state?.others);
  const freeNow = useView((v) => v.state?.disk?.free ?? null);
  const scanning = useView((v) => (v.state?.scan.status ?? 'idle') !== 'idle');
  const snap = useView((v) => v.state?.snapshot ?? null);

  const key = inspect?.key ?? focusKey;
  const n = store.tree.get(key);
  if (!n) return <section className="inspector" aria-label="Details" />;

  const d = inspect?.key === key ? inspect.detail : null;
  const loading = inspect?.key === key && inspect.loading;
  const error = inspect?.key === key ? inspect.error : null;
  const kind = n.kind ? kinds[n.kind] : null;
  const isFocus = n.key === focusKey;
  const base = isFocus ? n.parent : store.tree.get(focusKey);
  const total = sizeParts(n.size);
  const note = n.note ?? d?.note ?? null;

  return (
    <section className="inspector" aria-label="Details" aria-live="polite" aria-busy={loading}>
      <h2 className="insp-name">{titleOf(n)}</h2>
      <p className="insp-kind">
        {kind ? kind.label : ROLE_LINE[n.role]}
        {n.live && ' · being scanned'}
      </p>
      {(kind?.blurb ?? (n.role !== 'dir' && n.role !== 'file' ? note : null)) && (
        <p className="insp-blurb">{kind?.blurb ?? note}</p>
      )}

      <div className="insp-size">
        <Settle text={total.value} className="num insp-size-value" />
        <span className="insp-size-unit">{total.unit}</span>
        {base && base.size > 0 && n.size > 0 && (
          <span className="insp-share">
            {share(n.size, base.size)} of {base.name}
          </span>
        )}
      </div>

      {(n.rc > 0 || n.rv > 0) && (
        <div className="insp-heat">
          <HeatBar size={n.size} rc={n.rc} rv={n.rv} />
          <div className="insp-figures">
            {n.rc > 0 && (
              <span className="fig-rc">
                <i className="swatch swatch-rc" />
                <span className="num">{size(n.rc)}</span> safe to delete
              </span>
            )}
            {n.rv > 0 && (
              <span className="fig-rv">
                <i className="swatch swatch-rv" />
                <span className="num">{size(n.rv)}</span> worth a look
              </span>
            )}
          </div>
        </div>
      )}

      {isScanned(n) ? (
        <Scanned n={n} d={d} loading={loading} error={error} home={home} local={local} isFocus={isFocus} />
      ) : (
        <Part n={n} d={d} others={others ?? []} freeNow={freeNow} snap={snap} local={local} scanning={scanning} isFocus={isFocus} />
      )}
    </section>
  );
}

function Scanned({
  n,
  d,
  loading,
  error,
  home,
  local,
  isFocus,
}: {
  n: MNode & { id: string };
  d: Detail | null;
  loading: boolean;
  error: string | null;
  home: string | null;
  local: boolean;
  isFocus: boolean;
}) {
  const path = d?.path ?? store.pathOf(n.id);
  const entry = store.markedEntry(n.id, path);
  const around = entry ? null : store.markedAround(n);
  const priv = d?.priv ?? n.priv;
  const changed = d?.modified ?? n.mtime;
  const facts: [string, ReactNode][] = [];
  if (n.role === 'dir' || n.role === 'volume') {
    if (n.files) facts.push(['Files', count(n.files)]);
    if (n.dirs) facts.push(['Folders', count(n.dirs)]);
  }
  if (changed) facts.push(['Changed', ago(changed * 1000)]);
  // Clones and hard links share their blocks: deleting one copy frees only its own.
  if (priv !== null && priv !== undefined && n.size - priv > Math.max(1e6, n.size * 0.02))
    facts.push(['Frees at least', size(priv)]);

  return (
    <>
      {facts.length > 0 && (
        <dl className="insp-facts">
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className="num">{v}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="insp-path">
        {path ? (
          <>
            <span className="insp-path-text" title={path}>
              {shortPath(path, home, 52)}
            </span>
            <IconButton icon={<Icon icon="copy" size="sm" />} label="Copy path" size="sm" variant="ghost" onClick={() => void store.copyPath(n.id)} />
          </>
        ) : error ? (
          <span className="insp-error">
            <Icon icon="error" size="sm" />
            {error}
          </span>
        ) : (
          <span className="insp-path-text is-quiet">{loading ? 'Finding where it is' : ''}</span>
        )}
      </div>

      <div className="insp-actions">
        {canDive(n) && !isFocus && (
          <Button label="Open" size="sm" variant="secondary" endContent={<Icon icon="chevronRight" size="sm" />} onClick={() => void store.dive(n.key)} />
        )}
        <Button
          label="Reveal in Finder"
          size="sm"
          variant="secondary"
          isDisabled={!local}
          tooltip={local ? undefined : 'Works from a browser on the Mac itself.'}
          onClick={() => void store.revealInFinder(n.id)}
        />
        {entry ? (
          <Button
            label="Marked"
            size="sm"
            variant="secondary"
            icon={<MarkedIcon />}
            tooltip="Take it off the list"
            onClick={() => void store.unmark(entry.path)}
          />
        ) : (
          <Button
            label={around ? `In marked ${around.name}` : 'Mark'}
            size="sm"
            variant="ghost"
            icon={<MarkIcon />}
            isDisabled={Boolean(around) || n.key === DISK_KEY}
            tooltip={around ? undefined : 'Add it to the list of things to delete later'}
            onClick={() => void store.mark(n.id)}
          />
        )}
      </div>
    </>
  );
}

const UNREADABLE: Record<string, { label: (n: number) => string; why: (app: string) => string }> = {
  appData: {
    label: (n) => `${plural(n, 'app data folder')}`,
    why: () => 'Other apps keep these private. macOS can ask you to allow each one.',
  },
  fullDisk: {
    label: (n) => `${plural(n, 'folder')} behind Full Disk Access`,
    why: (app) => `Give ${app} Full Disk Access in System Settings, under Privacy & Security, then rescan.`,
  },
  desktop: { label: (n) => `${plural(n, 'folder')} on the Desktop`, why: () => 'macOS asks before an app reads the Desktop.' },
  documents: { label: (n) => `${plural(n, 'folder')} in Documents`, why: () => 'macOS asks before an app reads Documents.' },
  downloads: { label: (n) => `${plural(n, 'folder')} in Downloads`, why: () => 'macOS asks before an app reads Downloads.' },
  cloud: { label: (n) => `${plural(n, 'cloud folder')}`, why: () => 'macOS asks before an app reads iCloud Drive.' },
  locked: { label: (n) => `${plural(n, 'locked folder')}`, why: () => 'macOS keeps these closed to every app.' },
  stalled: { label: (n) => `${plural(n, 'folder')} that stopped answering`, why: () => 'Left closed so the scan could finish.' },
  skipped: { label: (n) => `${plural(n, 'folder')} skipped on purpose`, why: () => 'Spacewalk leaves these alone.' },
};

function Part({
  n,
  d,
  others,
  freeNow,
  snap,
  local,
  scanning,
  isFocus,
}: {
  n: MNode;
  d: Detail | null;
  others: { name: string; size: number; free: number }[];
  freeNow: number | null;
  snap: SnapInfo | null;
  local: boolean;
  scanning: boolean;
  isFocus: boolean;
}) {
  if (n.role === 'disk') {
    const then = d?.free;
    const now = freeNow ?? then;
    const facts: [string, ReactNode][] = [];
    if (now !== undefined) facts.push(['Free now', size(now)]);
    if (now !== undefined && then !== undefined && Math.abs(now - then) > 5e7) facts.push(['At the scan', size(then)]);
    if (snap?.files) facts.push(['Files', count(snap.files)]);
    if (snap?.dirs) facts.push(['Folders', count(snap.dirs)]);
    return (
      <dl className="insp-facts">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className="num">{v}</dd>
          </div>
        ))}
        {others.map((o) => (
          <div key={o.name} className="is-wide">
            <dt>{o.name}</dt>
            <dd className="num">
              {size(o.free)} free of {size(o.size)}
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  if (n.role === 'free')
    return d?.now !== null && d?.now !== undefined && Math.abs(d.now - n.size) > 5e7 ? (
      <p className="insp-line">
        <span className="num">{size(d.now)}</span> free right now
      </p>
    ) : null;

  if (n.role === 'more') {
    const parent = n.parent;
    return parent && !isFocus && canDive(parent) && parent.key !== store.view.focusKey ? (
      <div className="insp-actions">
        <Button
          label={`Open ${parent.name}`}
          size="sm"
          variant="secondary"
          endContent={<Icon icon="chevronRight" size="sm" />}
          onClick={() => void store.dive(parent.key)}
        />
      </div>
    ) : (
      <p className="insp-line is-quiet">Each one is too small to draw here. Search or the lists find them.</p>
    );
  }

  if (n.role === 'hidden' || n.role === 'pending') {
    const groups = Object.entries(d?.unreadable ?? {}).sort((a, b) => b[1].count - a[1].count);
    const app = d?.launchedFrom ?? 'the app you start Spacewalk from';
    const asks = d?.access && Object.values(d.access).includes('ask');
    return (
      <>
        {groups.length > 0 && (
          <ul className="insp-unread">
            {groups.map(([k, g]) => (
              <Group key={k} k={k} g={g} app={app} />
            ))}
          </ul>
        )}
        {n.role === 'hidden' && local && asks && !scanning && (
          <div className="insp-actions">
            <Button
              label="Scan and ask for access"
              size="sm"
              variant="secondary"
              icon={<RescanIcon />}
              tooltip="macOS will ask before Spacewalk reads each private folder"
              onClick={() => void store.scan('ask')}
            />
          </div>
        )}
      </>
    );
  }

  return null;
}

function Group({ k, g, app }: { k: string; g: Unreadable; app: string }) {
  const info = UNREADABLE[k] ?? { label: (n: number) => plural(n, 'folder'), why: () => '' };
  return (
    <li>
      <span className="insp-unread-label">{info.label(g.count)}</span>
      <span className="insp-unread-why">{info.why(app)}</span>
    </li>
  );
}
