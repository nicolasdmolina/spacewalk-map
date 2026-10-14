// Spacewalk's own marks, drawn on a 20 unit grid with a 1.5 stroke to sit
// beside Astryx's built-in icons.

import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

const base = (props: P): P => ({
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  ...props,
});

/** Three tiles of a map: the large one keeps, the hot one can go. */
export function LogoMark(props: P) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden {...props}>
      <rect x="1" y="1" width="9.5" height="18" rx="1" fill="#4A5058" />
      <rect x="11.5" y="1" width="7.5" height="10" rx="1" fill="#E5402F" />
      <rect x="11.5" y="12" width="7.5" height="7" rx="1" fill="#4A5058" />
    </svg>
  );
}

/** A page with its corner turned down: marked to delete later. */
export function MarkIcon(props: P) {
  return (
    <svg {...base(props)}>
      <path d="M5 2.75h6.5l3.5 3.5v11H5z" />
      <path d="M11.5 2.75v3.5H15" />
    </svg>
  );
}

export function MarkedIcon(props: P) {
  return (
    <svg {...base(props)}>
      <path d="M5 2.75h6.5l3.5 3.5v11H5z" />
      <path d="M11.5 2.75v3.5H15z" fill="currentColor" />
      <path d="M7.75 11.25l1.75 1.75 3-3.5" />
    </svg>
  );
}

/** Two arcs chasing: scan again. */
export function RescanIcon(props: P) {
  return (
    <svg {...base(props)}>
      <path d="M15.75 8.5A6 6 0 0 0 4.9 6.6" />
      <path d="M4.5 3.5v3.25h3.25" />
      <path d="M4.25 11.5a6 6 0 0 0 10.85 1.9" />
      <path d="M15.5 16.5v-3.25h-3.25" />
    </svg>
  );
}

/** Up one level. */
export function UpIcon(props: P) {
  return (
    <svg {...base(props)}>
      <path d="M10 15.5V4.75" />
      <path d="M5.25 9.25L10 4.5l4.75 4.75" />
    </svg>
  );
}

export function LockIcon(props: P) {
  return (
    <svg {...base(props)}>
      <rect x="4.25" y="8.75" width="11.5" height="8" rx="1" />
      <path d="M7 8.75V6.5a3 3 0 0 1 6 0v2.25" />
    </svg>
  );
}

/** A square with a corner cut: hidden from the scan. */
export function HiddenIcon(props: P) {
  return (
    <svg {...base(props)}>
      <rect x="3.25" y="3.25" width="13.5" height="13.5" rx="1" />
      <path d="M3.5 12.5l9-9M7.5 16.5l9-9M3.5 8.5l5-5M11.5 16.5l5-5" strokeWidth={1} />
    </svg>
  );
}
