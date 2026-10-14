// One listed thing. The left column holds its state mark and nothing else;
// the bar under it is its size against the list's largest, coloured the way
// the map colours it. Hovering lights its tile; clicking shows it on the map.

import type { Item, Kind } from '../lib/api';
import { parentPath, shortPath, size } from '../lib/format';
import { store } from '../lib/store';
import { HeatBar } from './HeatBar';
import { MarkIcon, MarkedIcon } from './icons';

export function ItemRow({
  item,
  max,
  home,
  kinds,
  marked,
  inside,
}: {
  item: Item;
  max: number;
  home: string | null;
  kinds: Record<string, Kind>;
  marked: string | null;
  inside: boolean;
}) {
  const key = () => store.tree.byId.get(String(item.id))?.key ?? null;
  const kind = item.kind ? kinds[item.kind] : null;
  const where = shortPath(parentPath(item.path), home, 40);
  const rc = item.rc ?? 0;
  const rv = item.rv ?? 0;

  return (
    <li
      className={`row${marked ? ' is-marked' : ''}`}
      onMouseEnter={() => store.hover(key())}
      onMouseLeave={() => store.hover(null)}
    >
      <span className="row-mark">
        {marked ? (
          <button type="button" className="mark-btn is-on" aria-label={`Unmark ${item.name}`} onClick={() => void store.unmark(marked)}>
            <MarkedIcon />
          </button>
        ) : inside ? (
          <span className="mark-btn is-inside" title="Inside a marked folder">
            <MarkedIcon />
          </span>
        ) : (
          <button type="button" className="mark-btn" aria-label={`Mark ${item.name} to delete later`} onClick={() => void store.mark(item.id)}>
            <MarkIcon />
          </button>
        )}
      </span>
      <button type="button" className="row-main" onClick={() => void store.reveal(item)} onFocus={() => store.hover(key())}>
        <span className="row-top">
          <span className="row-name">{item.name}</span>
          <span className={`row-size num${rc > item.size / 2 ? ' is-rc' : ''}`}>{size(item.size)}</span>
        </span>
        <span className="row-sub">
          {kind ? `${kind.label} · ` : ''}
          {where}
        </span>
        <HeatBar size={item.size} rc={rc} rv={rv} className="row-bar" scale={max > 0 ? item.size / max : 1} />
      </button>
    </li>
  );
}
