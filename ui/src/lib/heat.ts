// Heat: how much of a thing can go, as a colour. Graphite is keep, oxide is
// check first, red is safe to delete. The ramp runs through OKLab so its
// lightness climbs evenly, which keeps it readable without colour vision.
// Tiles stop at a red deep enough for white labels (4.6:1); the brighter
// signal red is for marks and text on the dark ground.

export type RGB = [number, number, number];

export const INK = '#F2F2F2';
export const GROUND = '#0E0F11';
export const GRAPHITE = '#2A2E33';
export const OXIDE = '#8E2B22';
export const TILE_RED = '#C8392B';
export const SIGNAL_RED = '#E5402F';
export const LINE = '#4A5058';

const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const toLin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const toByte = (c: number) => {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
};

function toLab([r8, g8, b8]: RGB): RGB {
  const r = toLin(r8);
  const g = toLin(g8);
  const b = toLin(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromLab([L, a, b]: RGB): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    toByte(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toByte(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

const STOPS = [toLab(hex(GRAPHITE)), toLab(hex(OXIDE)), toLab(hex(TILE_RED))];
const STEPS = 256;
const LUT: RGB[] = [];
for (let i = 0; i < STEPS; i++) {
  const t = (i / (STEPS - 1)) * 2;
  const k = Math.min(1, Math.floor(t));
  const f = t - k;
  const a = STOPS[k];
  const b = STOPS[k + 1];
  LUT.push(fromLab([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]));
}

/** 0 keep, 0.5 all worth a look, 1 all safe to delete. */
export function heat(size: number, rc = 0, rv = 0): number {
  if (!(size > 0)) return 0;
  return Math.min(1, Math.max(0, (rc + 0.5 * rv) / size));
}

export function heatRGB(h: number): RGB {
  return LUT[Math.round(Math.min(1, Math.max(0, h)) * (STEPS - 1))];
}

export function heatCSS(h: number): string {
  return css(heatRGB(h));
}

export function css([r, g, b]: RGB, alpha = 1): string {
  return alpha >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`;
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export const rgb = hex;
