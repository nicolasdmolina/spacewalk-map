// The card that follows the pointer over the map: what a tile is, how much
// of the view it takes, and how much of it can go. On touch it docks at the
// bottom of the map with the item's actions, since there is no hover or
// right-click.

import { useImperativeHandle, useRef, type Ref, type SyntheticEvent } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import type { Kind } from '../lib/api';
import { ago, plural, share, size } from '../lib/format';
import { canDive, isScanned, type MNode } from '../lib/model';
import { store } from '../lib/store';
import { HeatBar } from './HeatBar';
import { MarkIcon, MarkedIcon } from './icons';

export interface PeekHandle {
  move(x: number, y: number, w: number, h: number): void;
}

const ROLE_HINT: Partial<Record<MNode['role'], string>> = {
  hidden: 'Used space the scan could not see. Select it to see why.',
  pending: 'Still to scan.',
  free: 'Free space on this disk.',
  overhead: 'Space the file system keeps for its own records.',
  more: 'Items too small to draw at this size. Open their folder to see them.',
};

export function titleOf(n: MNode): string {
  if (n.role === 'more' && n.count) return `${n.count.toLocaleString('en-US')} more items`;
  return n.name;
}

export function hintOf(n: MNode): string {
  const special = ROLE_HINT[n.role];
  if (special) return special;
  if (n.live) return 'Being scanned now.';
  if (n.role === 'volume' && !n.open) return 'A macOS volume. Spacewalk does not look inside it.';
  if (n.role === 'file') return n.mtime ? `File, changed ${ago(n.mtime * 1000)}` : 'File';
  const files = n.files ? plural(n.files, 'file') : '';
  return canDive(n) ? (files ? `${files}. Click to open.` : 'Click to open.') : files;
}

export function Peek({
  node,
  focus,
  kinds,
  touch,
  onOpen,
  ref,
}: {
  node: MNode | null;
  focus: MNode | null;
  kinds: Record<string, Kind>;
  touch: boolean;
  onOpen: () => void;
  ref?: Ref<PeekHandle>;
}) {
  const el = useRef<HTMLDivElement>(null);
  const last = useRef<MNode | null>(node);
  if (node) last.current = node;
  const n = node ?? last.current;

  useImperativeHandle(
    ref,
    () => ({
      move(x, y, w, h) {
        const card = el.current;
        if (!card || touch) return;
        const cw = card.offsetWidth;
        const ch = card.offsetHeight;
        let px = x + 18;
        let py = y + 20;
        if (px + cw > w - 8) px = x - 14 - cw;
        if (py + ch > h - 8) py = y - 14 - ch;
        card.style.transform = `translate3d(${Math.round(Math.max(8, px))}px, ${Math.round(Math.max(8, py))}px, 0)`;
      },
    }),
    [touch],
  );

  const kind = n?.kind ? kinds[n.kind] : null;
  const isFocus = !!n && !!focus && n.key === focus.key;
  // Docked, the card takes its own taps; the map under it does not see them.
  const keep = (e: SyntheticEvent) => e.stopPropagation();
  const guard = touch
    ? { onPointerDown: keep, onPointerUp: keep, onPointerMove: keep, onPointerCancel: keep, onTouchStart: keep, onContextMenu: keep }
    : {};
  return (
    <div
      ref={el}
      className={`peek${node ? ' is-shown' : ''}${touch ? ' is-docked' : ''}`}
      aria-hidden={!touch || !node}
      {...guard}
    >
      {n && (
        <>
          <div className="peek-name">{titleOf(n)}</div>
          {kind && <div className="peek-kind">{kind.label}</div>}
          <div className="peek-size">
            <span className="num">{size(n.size)}</span>
            {!isFocus && focus && focus.size > 0 && (
              <span className="peek-share">
                {share(n.size, focus.size)} of {focus.name}
              </span>
            )}
          </div>
          {(n.rc > 0 || n.rv > 0) && (
            <>
              <HeatBar size={n.size} rc={n.rc} rv={n.rv} />
              <div className="peek-figures">
                {n.rc > 0 && (
                  <span>
                    <i className="swatch swatch-rc" />
                    <span className="num">{size(n.rc)}</span> safe to delete
                  </span>
                )}
                {n.rv > 0 && (
                  <span>
                    <i className="swatch swatch-rv" />
                    <span className="num">{size(n.rv)}</span> worth a look
                  </span>
                )}
              </div>
            </>
          )}
          {touch ? (
            <Actions n={n} open={canDive(n) && !isFocus} onOpen={onOpen} />
          ) : (
            <div className="peek-hint">{hintOf(n)}</div>
          )}
        </>
      )}
    </div>
  );
}

/** What the right-click menu offers, as buttons a thumb can reach. */
function Actions({ n, open, onOpen }: { n: MNode; open: boolean; onOpen: () => void }) {
  const scanned = isScanned(n) ? n : null;
  if (!open && !scanned) return <div className="peek-hint">{hintOf(n).replace(' Click to open.', '')}</div>;
  const entry = scanned ? store.markedEntry(scanned.id) : null;
  const around = scanned && !entry ? store.markedAround(scanned) : null;
  return (
    <div className="peek-actions">
      {open && (
        <Button label="Open" size="sm" variant="primary" endContent={<Icon icon="chevronRight" size="sm" />} onClick={onOpen} />
      )}
      {scanned &&
        (entry ? (
          <Button label="Marked" size="sm" variant="secondary" icon={<MarkedIcon />} onClick={() => void store.unmark(entry.path)} />
        ) : (
          <Button
            label={around ? 'In a marked folder' : 'Mark'}
            size="sm"
            variant="secondary"
            icon={<MarkIcon />}
            isDisabled={Boolean(around)}
            onClick={() => void store.mark(scanned.id)}
          />
        ))}
      {scanned && (
        <IconButton icon={<Icon icon="copy" size="sm" />} label="Copy path" size="sm" variant="ghost" onClick={() => void store.copyPath(scanned.id)} />
      )}
    </div>
  );
}
