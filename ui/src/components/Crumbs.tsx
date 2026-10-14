// The row over the map: up a level, the way down to the focus, and what the
// focus holds, with the part that can go in red.

import { BreadcrumbItem, Breadcrumbs } from '@astryxdesign/core/Breadcrumbs';
import { IconButton } from '@astryxdesign/core/IconButton';
import { size, sizeParts } from '../lib/format';
import { DISK_KEY, ancestors, type MNode } from '../lib/model';
import { store, useView } from '../lib/store';
import { UpIcon } from './icons';
import { Settle } from './Settle';

const KEEP_END = 3;

export function Crumbs() {
  const focusKey = useView((v) => v.focusKey);
  useView((v) => v.treeVersion);
  const busy = useView((v) => v.busy);
  const focus = store.tree.get(focusKey) ?? store.tree.root;

  const chain: MNode[] = focus ? [...ancestors(focus), focus] : [];
  // Long ways down keep the disk and the last few steps; the middle folds into a menu.
  const folded = chain.length > KEEP_END + 2 ? chain.slice(1, chain.length - KEEP_END) : [];
  const shown = folded.length ? [chain[0], null, ...chain.slice(chain.length - KEEP_END)] : chain;
  const total = focus ? sizeParts(focus.size) : null;

  return (
    <div className={`crumbs${busy ? ' is-busy' : ''}`}>
      <IconButton
        icon={<UpIcon />}
        label="Up one level"
        size="sm"
        variant="ghost"
        isDisabled={!focus || focus.key === DISK_KEY}
        onClick={() => void store.up()}
      />
      <Breadcrumbs label="Where the map is">
        {shown.map((n, i) =>
          n === null ? (
            <BreadcrumbItem
              key="fold"
              menu={folded.map((f) => ({ label: f.name, onClick: () => void store.up(f.key) }))}
            >
              {`${folded.length} more`}
            </BreadcrumbItem>
          ) : (
            <BreadcrumbItem
              key={n.key}
              isCurrent={i === shown.length - 1}
              onClick={i === shown.length - 1 ? undefined : () => void store.up(n.key)}
            >
              {n.name}
            </BreadcrumbItem>
          ),
        )}
      </Breadcrumbs>
      {focus && total && (
        <div className="crumbs-figures">
          <span className="crumbs-size">
            <Settle text={total.value} className="num" /> {total.unit}
          </span>
          {focus.rc > 0 && (
            <span className="crumbs-reclaim">
              <span className="num">{size(focus.rc)}</span> safe to delete
            </span>
          )}
        </div>
      )}
      <span className="busyline" aria-hidden />
    </div>
  );
}
