// The strip over everything: the mark and the machine, search, and the scan,
// with a hairline along the bottom edge that fills while a scan runs.

import { useEffect, useReducer, useRef } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { Kbd } from '@astryxdesign/core/Kbd';
import { TextInput } from '@astryxdesign/core/TextInput';
import { ago, compact, size, sizeParts } from '../lib/format';
import { store, useView } from '../lib/store';
import { LogoMark, RescanIcon } from './icons';
import { Settle } from './Settle';

export function TopBar() {
  const machine = useView((v) => v.state?.machine ?? '');
  const disk = useView((v) => v.state?.disk ?? null);
  const scan = useView((v) => v.state?.scan ?? null);
  const snapAt = useView((v) => v.state?.snapshot?.createdAt ?? null);
  const progress = useView((v) => v.progress);
  const query = useView((v) => v.query);
  const searching = useView((v) => v.searching);
  const input = useRef<HTMLInputElement>(null);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  // Keep "Scanned 5 minutes ago" true while the page stays open.
  useEffect(() => {
    const t = window.setInterval(tick, 60e3);
    return () => window.clearInterval(t);
  }, []);

  // "/" jumps to search from anywhere that is not already taking text.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const running = scan && scan.status !== 'idle';
  const expected = scan?.expected?.bytes ?? 0;
  const done = running && progress && expected ? Math.min(0.985, progress.bytes / expected) : null;

  return (
    <header className="topbar">
      <div className="brand">
        <LogoMark className="brand-mark" />
        <span className="brand-name">Spacewalk</span>
        {machine && <span className="brand-machine">{machine}</span>}
      </div>

      <div className="search" role="search">
        <TextInput
          ref={input}
          label="Find files and folders"
          isLabelHidden
          value={query}
          onChange={(v) => store.setQuery(v)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              if (query) store.setQuery('');
              else e.currentTarget.blur();
            }
          }}
          placeholder="Find files and folders"
          startIcon="search"
          size="sm"
          hasClear
          isLoading={searching}
          width="100%"
        />
        {!query && (
          <span className="search-kbd" aria-hidden>
            <Kbd keys="/" />
          </span>
        )}
      </div>

      <div className="scan">
        {disk && (
          <span className="scan-free">
            <span className="num">{size(disk.free)}</span> free of <span className="num">{size(disk.size)}</span>
          </span>
        )}
        {running ? (
          <>
            <span className="scan-live" aria-live="off">
              {scan.status === 'finishing' ? (
                'Saving the map'
              ) : (
                <>
                  Scanning <Settle text={compact(progress?.files ?? 0)} className="num" /> files,{' '}
                  <Settle text={sizeParts(progress?.bytes ?? 0).value} className="num" /> {sizeParts(progress?.bytes ?? 0).unit}
                </>
              )}
            </span>
            <Button
              label="Stop"
              size="sm"
              variant="ghost"
              icon={<Icon icon="stop" size="sm" />}
              isDisabled={scan.status === 'finishing'}
              onClick={() => void store.stopScan()}
            />
          </>
        ) : (
          <>
            {snapAt ? (
              <span className="scan-when">Scanned {ago(snapAt)}</span>
            ) : (
              <span className="scan-when">Not scanned yet</span>
            )}
            <Button
              label={snapAt ? 'Rescan' : 'Scan'}
              size="sm"
              variant={snapAt ? 'secondary' : 'primary'}
              icon={<RescanIcon />}
              tooltip={snapAt ? 'Scan the disk again. The map stays up until the new one is ready.' : undefined}
              onClick={() => void store.scan('auto')}
            />
          </>
        )}
      </div>

      <div
        className={`scanline${running ? ' is-on' : ''}${done === null ? ' is-open' : ''}`}
        role="progressbar"
        aria-label="Scan progress"
        aria-hidden={!running}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={done === null ? undefined : Math.round(done * 100)}
      >
        <span style={done === null ? undefined : { transform: `scaleX(${done})` }} />
      </div>
    </header>
  );
}
