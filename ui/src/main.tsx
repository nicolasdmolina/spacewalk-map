import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '@fontsource-variable/archivo/wdth.css';
import './styles/app.css';
import { Theme } from '@astryxdesign/core/theme';
import { ToastViewport } from '@astryxdesign/core/Toast';
import { App } from './App';
import { spacewalkTheme } from './theme';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Theme theme={spacewalkTheme} mode="dark">
      <ToastViewport position="bottomStart" maxVisible={3} inset={{ bottom: 44, start: 12 }}>
        <App />
      </ToastViewport>
    </Theme>
  </StrictMode>,
);
