// The lists beside the map, for the place the map is looking at: what can go,
// grouped by what it is; the largest files; and the marked list. A search
// takes the panel over until it is cleared.

import { useMemo, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import type { Category, Insights, Item, JettisonItem, JettisonView, Kind } from '../lib/api';
import { copyText } from '../lib/copy';
import { count, plural, shortPath, size } from '../lib/format';
import { store, useView, type Tab as TabName } from '../lib/store';
import { ItemRow } from './ItemRow';
import { MarkedIcon } from './icons';

const NO_KINDS: Record<string, Kind> = {};

interface Ctx {
  home: string | null;
  kinds: Record<string, Kind>;
  marked: (item: Item) => string | null;
  inside: (item: Item) => boolean;
}

function useMarks(j: JettisonView | null) {
  return useMemo(() => {
    const items = j?.items ?? [];
    const byPath = new Set(items.map((it) => it.path));
    return {
      marked: (item: Item) =>
        byPath.has(item.path) ? item.path : (items.find((it) => it.id !== null && it.id === item.id)?.path ?? null),
      inside: (item: Item) => items.some((it) => item.path.startsWith(it.path.endsWith('/') ? it.path : `${it.path}/`)),
    };
  }, [j]);
}

export function SidePanel() {
  const query = useView((v) => v.query);
  const search = useView((v) => v.search);
  const searching = useView((v) => v.searching);
  const tab = useView((v) => v.tab);
  const insights = useView((v) => v.insights);
  const insightsLoading = useView((v) => v.insightsLoading);
  const jettison = useView((v) => v.jettison);
  const kinds = useView((v) => v.state?.kinds ?? NO_KINDS);
  const home = useView((v) => v.state?.home ?? null);
  const hasSnap = useView((v) => Boolean(v.state?.snapshot));
  const marks = useMarks(jettison);
  const ctx: Ctx = { home, kinds, ...marks };
  const live = jettison?.items.filter((it) => !it.gone).length ?? 0;

  if (query.trim())
    return (
      <section className="panel" aria-label="Search results">
        <Results query={query.trim()} items={search?.items ?? null} total={search?.total ?? 0} searching={searching} ctx={ctx} />
      </section>
    );

  return (
    <section className="panel" aria-label="Lists">
      <TabList value={tab} onChange={(v) => store.setTab(v as TabName)} size="sm" layout="fill" hasDivider>
        <Tab value="reclaim" label="Can go" />
        <Tab value="largest" label="Largest" />
        <Tab value="marked" label="Marked" endContent={live ? <span className="tab-count num">{live}</span> : undefined} />
      </TabList>
      <div className="panel-body" aria-busy={insightsLoading}>
        {!hasSnap ? (
          <p className="panel-empty">The lists fill in when the first scan finishes.</p>
        ) : tab === 'marked' ? (
          <Marked view={jettison} ctx={ctx} />
        ) : !insights ? (
          <div className="panel-wait">
            <Spinner size="sm" shade="subtle" label="Reading the scan" />
          </div>
        ) : tab === 'reclaim' ? (
          <Reclaim insights={insights} ctx={ctx} />
        ) : (
          <Largest insights={insights} ctx={ctx} />
        )}
      </div>
    </section>
  );
}

function scopeName(insights: Insights) {
  return insights.scope === null ? 'this Mac' : (store.tree.byId.get(String(insights.scope))?.name ?? 'this folder');
}

function Rows({ items, ctx }: { items: Item[]; ctx: Ctx }) {
  const max = items.reduce((m, it) => Math.max(m, it.size), 0);
  return (
    <ul className="rows">
      {items.map((it) => (
        <ItemRow
          key={it.id}
          item={it}
          max={max}
          home={ctx.home}
          kinds={ctx.kinds}
          marked={ctx.marked(it)}
          inside={ctx.inside(it)}
        />
      ))}
    </ul>
  );
}

function Reclaim({ insights, ctx }: { insights: Insights; ctx: Ctx }) {
  const [open, setOpen] = useState<string | null>(null);
  const max = insights.categories.reduce((m, c) => Math.max(m, c.size), 0);
  const { reclaim, review } = insights;
  const scope = scopeName(insights);
  if (!insights.categories.length) return <p className="panel-empty">Nothing in {scope} looks safe to delete.</p>;
  const sure = insights.categories.filter((c) => c.tone === 'reclaim');
  const maybe = insights.categories.filter((c) => c.tone !== 'reclaim');
  const group = (cats: Category[]) => (
    <ul className="cats">
      {cats.map((c) => (
        <CategoryRow
          key={c.kind}
          c={c}
          max={max}
          isOpen={open === c.kind}
          onToggle={() => setOpen((o) => (o === c.kind ? null : c.kind))}
          ctx={ctx}
        />
      ))}
    </ul>
  );
  // The total for the place already heads the map, so each group here carries only its own sum.
  return (
    <>
      {sure.length > 0 ? (
        <>
          <h3 className="list-head tone-reclaim">
            Safe to delete <span className="list-head-sum num">{size(reclaim.size)}</span>
          </h3>
          {reclaim.priv < reclaim.size * 0.98 && (
            <p className="list-note is-flush">
              Deleting it all frees at least <span className="num">{size(reclaim.priv)}</span>.
            </p>
          )}
          {group(sure)}
        </>
      ) : (
        <p className="list-note is-flush">Nothing here is safe to delete without checking first.</p>
      )}
      {maybe.length > 0 && (
        <>
          <h3 className="list-head">
            Worth a look <span className="list-head-sum num">{size(review.size)}</span>
          </h3>
          {group(maybe)}
        </>
      )}
    </>
  );
}

function CategoryRow({
  c,
  max,
  isOpen,
  onToggle,
  ctx,
}: {
  c: Category;
  max: number;
  isOpen: boolean;
  onToggle: () => void;
  ctx: Ctx;
}) {
  const id = `cat-${c.kind}`;
  return (
    <li className={`cat tone-${c.tone}${isOpen ? ' is-open' : ''}`}>
      <button type="button" className="cat-head" aria-expanded={isOpen} aria-controls={id} onClick={onToggle}>
        <span className="cat-chevron">
          <Icon icon="chevronRight" size="sm" />
        </span>
        <span className="cat-label">{c.label}</span>
        <span className="cat-size num">{size(c.size)}</span>
        <span className="cat-bar" aria-hidden>
          <span style={{ width: `${Math.max(1.5, (c.size / Math.max(1, max)) * 100)}%` }} />
        </span>
        <span className="cat-count">{plural(c.count, 'item')}</span>
      </button>
      {isOpen && (
        <div id={id} className="cat-body">
          <p className="cat-blurb">{c.blurb}</p>
          <Rows items={c.items} ctx={ctx} />
          {c.count > c.items.length && (
            <p className="list-note">
              The largest {count(c.items.length)} of {count(c.count)}.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function Largest({ insights, ctx }: { insights: Insights; ctx: Ctx }) {
  return (
    <>
      <h3 className="list-head">Largest files in {scopeName(insights)}</h3>
      {insights.files.length ? <Rows items={insights.files} ctx={ctx} /> : <p className="panel-empty">No large files here.</p>}
      {insights.stale.length > 0 && (
        <>
          <h3 className="list-head">Untouched for {insights.staleDays} days</h3>
          <Rows items={insights.stale} ctx={ctx} />
        </>
      )}
    </>
  );
}

function Marked({ view, ctx }: { view: JettisonView | null; ctx: Ctx }) {
  const items = view?.items ?? [];
  if (!items.length)
    return (
      <p className="panel-empty">
        Nothing marked yet. Right-click a tile, press M on the map, or use the mark beside any item in these lists.
      </p>
    );
  const left = items.filter((it) => !it.gone);
  const copyAll = async () => {
    const ok = await copyText(left.map((it) => it.path).join('\n'));
    store.notify(
      ok
        ? { body: `Copied ${plural(left.length, 'path')}`, id: 'copy' }
        : { body: 'The browser would not copy them.', type: 'error' },
    );
  };
  return (
    <>
      <div className="totals">
        <p className="totals-main is-plain">
          <span className="num">{size(view?.planned ?? 0)}</span> marked to delete
        </p>
        <p className="totals-sub">
          {view && view.freed > 0 ? (
            <>
              <span className="num">{size(view.freed)}</span> already gone since you marked it.{' '}
            </>
          ) : null}
          Spacewalk never deletes anything. Copy the paths or reveal them in Finder, then delete them yourself.
        </p>
        <div className="totals-actions">
          {left.length > 0 && <Button label="Copy all paths" size="sm" variant="secondary" icon={<Icon icon="copy" size="sm" />} onClick={() => void copyAll()} />}
          {view && view.freed > 0 && (
            <Button label="Clear the gone ones" size="sm" variant="ghost" onClick={() => void store.clearFreed()} />
          )}
        </div>
      </div>
      <ul className="rows">
        {items.map((it) => (
          <MarkedRow key={it.path} it={it} home={ctx.home} max={Math.max(...items.map((x) => x.now ?? x.size))} />
        ))}
      </ul>
    </>
  );
}

function MarkedRow({ it, home, max }: { it: JettisonItem; home: string | null; max: number }) {
  const shown = it.now ?? it.size;
  const id = it.id;
  return (
    <li className={`row is-marked${it.gone ? ' is-gone' : ''}`}>
      <span className="row-mark">
        {it.gone ? (
          <span className="mark-btn is-gone" title="Gone since the last scan">
            <Icon icon="check" size="sm" />
          </span>
        ) : (
          <button type="button" className="mark-btn is-on" aria-label={`Unmark ${it.name}`} onClick={() => void store.unmark(it.path)}>
            <MarkedIcon />
          </button>
        )}
      </span>
      <button
        type="button"
        className="row-main"
        disabled={it.gone || id === null}
        onClick={() => id !== null && void store.reveal({ id, name: it.name })}
        onMouseEnter={() => store.hover(id === null ? null : (store.tree.byId.get(String(id))?.key ?? null))}
        onMouseLeave={() => store.hover(null)}
      >
        <span className="row-top">
          <span className="row-name">{it.name}</span>
          <span className="row-size num">{it.gone ? `${size(it.size)} freed` : size(shown)}</span>
        </span>
        <span className="row-sub">{shortPath(it.path, home, 44)}</span>
        {!it.gone && <span className="heatbar row-bar is-plain" style={{ width: `${Math.max(1.5, (shown / Math.max(1, max)) * 100)}%` }} />}
      </button>
    </li>
  );
}

function Results({
  query,
  items,
  total,
  searching,
  ctx,
}: {
  query: string;
  items: Item[] | null;
  total: number;
  searching: boolean;
  ctx: Ctx;
}) {
  if (!items)
    return (
      <div className="panel-wait">
        <Spinner size="sm" shade="subtle" label="Searching" />
      </div>
    );
  return (
    <div className="panel-body">
      <h3 className="list-head is-plain">
        {total ? (
          <>
            {plural(total, 'match', 'matches')} for “{query}”
          </>
        ) : (
          <>No matches for “{query}”</>
        )}
        {searching && <Spinner size="sm" shade="subtle" label="Searching" />}
      </h3>
      {items.length > 0 && <Rows items={items} ctx={ctx} />}
      {total > items.length && <p className="list-note">The largest {count(items.length)}, by size.</p>}
    </div>
  );
}
