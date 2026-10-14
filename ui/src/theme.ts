// Astryx, dressed for the map: near-black ground, graphite rules, white type
// and controls. Red never appears here; it belongs to reclaimable bytes on the
// map and in the lists. Pairs are [on a light surface, on the dark page]; the
// page is always dark, and the light values only serve inverted toasts.

import { defineTheme } from '@astryxdesign/core/theme';

const SANS = '"Archivo Variable", "Archivo", ui-sans-serif, system-ui, sans-serif';

export const spacewalkTheme = defineTheme({
  name: 'spacewalk',
  tokens: {
    '--color-accent': ['#0E0F11', '#F2F2F2'],
    '--color-accent-muted': ['rgba(14, 15, 17, 0.12)', 'rgba(242, 242, 242, 0.14)'],
    '--color-on-accent': ['#F2F2F2', '#0E0F11'],
    '--color-text-accent': ['#0E0F11', '#F2F2F2'],
    '--color-icon-accent': ['#0E0F11', '#F2F2F2'],
    '--color-neutral': ['rgba(14, 15, 17, 0.1)', 'rgba(242, 242, 242, 0.12)'],

    '--color-background-body': '#0E0F11',
    '--color-background-surface': '#0E0F11',
    '--color-background-card': '#16181B',
    '--color-background-popover': '#16181B',
    '--color-background-muted': '#16181B',
    '--color-background-inverted': '#F2F2F2',
    '--color-background-error-inverted': '#2A2E33',

    '--color-text-primary': ['#0E0F11', '#F2F2F2'],
    '--color-text-secondary': ['#3A3F46', '#9AA0A8'],
    '--color-text-disabled': ['#6B717A', '#6B717A'],
    '--color-icon-primary': ['#0E0F11', '#F2F2F2'],
    '--color-icon-secondary': ['#3A3F46', '#9AA0A8'],
    '--color-icon-disabled': ['#6B717A', '#6B717A'],
    '--color-on-dark': '#F2F2F2',
    '--color-on-light': '#0E0F11',

    '--color-border': ['rgba(14, 15, 17, 0.14)', '#2A2E33'],
    '--color-border-emphasized': ['#6B717A', '#4A5058'],
    '--color-track': ['#C9CDD2', '#2A2E33'],
    '--color-skeleton': ['#C9CDD2', '#2A2E33'],
    '--color-overlay': 'rgba(14, 15, 17, 0.64)',
    '--color-overlay-hover': ['rgba(14, 15, 17, 0.06)', 'rgba(242, 242, 242, 0.06)'],
    '--color-overlay-pressed': ['rgba(14, 15, 17, 0.12)', 'rgba(242, 242, 242, 0.11)'],
    '--color-tint-hover': ['black', 'white'],
    '--color-shadow': 'rgba(0, 0, 0, 0.5)',

    // Problems speak in white with an icon; red means reclaimable space.
    '--color-error': ['#0E0F11', '#F2F2F2'],
    '--color-error-muted': ['rgba(14, 15, 17, 0.12)', 'rgba(242, 242, 242, 0.14)'],
    '--color-on-error': ['#F2F2F2', '#0E0F11'],

    '--shadow-low': '0 1px 2px rgba(0, 0, 0, 0.45)',
    '--shadow-med': '0 2px 4px rgba(0, 0, 0, 0.4), 0 8px 20px rgba(0, 0, 0, 0.35)',
    '--shadow-high': '0 4px 8px rgba(0, 0, 0, 0.45), 0 16px 40px rgba(0, 0, 0, 0.5)',
    '--shadow-inset-selected': 'inset 0 0 0 2px #F2F2F2',

    '--radius-inner': '2px',
    '--radius-element': '3px',
    '--radius-container': '4px',
    '--radius-page': '0px',

    '--font-family-body': SANS,
    '--font-family-heading': SANS,
    '--font-family-code': 'ui-monospace, "SF Mono", Menlo, monospace',

    '--ease-standard': 'cubic-bezier(0.16, 1, 0.3, 1)',
  },
});
