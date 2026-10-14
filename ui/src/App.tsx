// One screen: the bar, the way down, the map and its legend, and the column
// with the details and the lists. The map waits, scans and recovers in place.

import { useEffect } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { Spinner } from '@astryxdesign/core/Spinner';
import { useToast } from '@astryxdesign/core/Toast';
import { store, useView } from './lib/store';
import { MapCanvas } from './treemap/MapCanvas';
import { Crumbs } from './components/Crumbs';
import { Inspector } from './components/Inspector';
import { Legend } from './components/Legend';
import { SidePanel } from './components/SidePanel';
import { TopBar } from './components/TopBar';
import { RescanIcon } from './components/icons';

export function App() {
  const toast = useToast();
  const ready = useView((v) => v.state !== null);
  const bootError = useView((v) => v.bootError);
  const conn = useView((v) => v.conn);
  const hasMap = useView((v) => Boolean(v.state?.snapshot) || (v.state?.scan.status ?? 'idle') !== 'idle');

  useEffect(() => {
    void store.start();
  }, []);

  useEffect(
    () =>
      store.onNotice((n) => {
        toast({
          body:
            n.type === 'error' ? (
              <span className="toast-error">
                <Icon icon="error" size="sm" />
                {n.body}
              </span>
            ) : (
              n.body
            ),
          type: n.type ?? 'info',
          uniqueID: n.id,
          collisionBehavior: 'overwrite',
          autoHideDuration: n.type === 'error' ? 8000 : 4000,
        });
      }),
    [toast],
  );

  useEffect(() => {
    if (conn === 'lost')
      store.notify({ body: 'Lost touch with Spacewalk. Trying again.', type: 'error', id: 'conn' });
  }, [conn]);

  return (
    <div className="app">
      <TopBar />
      <Crumbs />
      <main className="stage">
        {ready && hasMap ? (
          <MapCanvas />
        ) : (
          <div className={`stage-note${ready && !bootError ? ' is-empty' : ''}`} role="status">
            {bootError ? (
              <div className="stage-card">
                <Icon icon="error" size="md" />
                <p className="stage-title">Spacewalk is not answering</p>
                <p className="stage-text">{bootError} Trying again in a moment.</p>
              </div>
            ) : !ready ? (
              <Spinner size="md" shade="subtle" label="Opening the map" />
            ) : (
              <div className="stage-card">
                <p className="stage-title">No map yet</p>
                <p className="stage-text">
                  A scan reads the size of every file on this Mac. It takes about a minute, and nothing is changed.
                </p>
                <Button label="Scan this Mac" variant="primary" icon={<RescanIcon />} onClick={() => void store.scan('auto')} />
              </div>
            )}
          </div>
        )}
      </main>
      <Legend />
      <aside className="side">
        <Inspector />
        <SidePanel />
      </aside>
    </div>
  );
}
