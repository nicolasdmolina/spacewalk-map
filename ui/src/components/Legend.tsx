// The strip under the map: how to read its colours and patterns, and what
// the scan behind it covered.

import { ago, compact, size } from '../lib/format';
import { useView } from '../lib/store';

export function Legend() {
  const snap = useView((v) => v.state?.snapshot ?? null);
  return (
    <footer className="legend">
      <span className="legend-key is-ramp">
        <span className="legend-ramp" aria-hidden />
        <span className="legend-ramp-labels">
          <span>Keep</span>
          <span>Worth a look</span>
          <span className="is-rc">Safe to delete</span>
        </span>
      </span>
      <span className="legend-key">
        <span className="legend-swatch is-free" aria-hidden />
        Free
      </span>
      <span className="legend-key">
        <span className="legend-swatch is-hidden" aria-hidden />
        Not seen by the scan
      </span>
      {snap && (
        <span className="legend-facts">
          <span className="num">{compact(snap.files)}</span> files, <span className="num">{size(snap.bytes)}</span> scanned{' '}
          {ago(snap.createdAt)}
        </span>
      )}
    </footer>
  );
}
