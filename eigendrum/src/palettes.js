const clamp01 = (x) => Math.max(0, Math.min(1, x));

function hexToRgb(hex) {
  const value = hex.replace('#', '');
  const n = Number.parseInt(value, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const PALETTES = [
  {
    id: 'glvis-five',
    name: 'GLVis 5-color',
    stops: ['#173b8f', '#00a6ca', '#51b849', '#ffd23f', '#c51b2e'],
  },
  {
    id: 'glvis-coldhot',
    name: 'GLVis cold–hot',
    stops: ['#182659', '#3156a5', '#81b5d4', '#f5f1e8', '#efad77', '#c8523f', '#6e1726'],
  },
  {
    id: 'glvis-jet',
    name: 'GLVis jet-like',
    stops: ['#00007f', '#0000ff', '#00bfff', '#00ff7f', '#ffff00', '#ff7f00', '#7f0000'],
  },
  {
    id: 'glvis-terrain',
    name: 'GLVis terrain',
    stops: ['#253a6e', '#397b8b', '#79a95a', '#d7c873', '#9a7147', '#f2efe7'],
  },
  {
    id: 'glvis-bone',
    name: 'GLVis bone',
    stops: ['#101418', '#35434b', '#72858b', '#b9c4bf', '#ffffff'],
  },
  {
    id: 'viridis',
    name: 'Viridis',
    stops: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  },
  {
    id: 'plasma',
    name: 'Plasma',
    stops: ['#0d0887', '#7e03a8', '#cc4778', '#f89540', '#f0f921'],
  },
  {
    id: 'gray',
    name: 'Grayscale',
    stops: ['#161616', '#676767', '#d1d1d1', '#ffffff'],
  },
];

export function getPalette(id) {
  return PALETTES.find((palette) => palette.id === id) ?? PALETTES[0];
}

export function samplePalette(paletteOrId, t) {
  const palette = typeof paletteOrId === 'string' ? getPalette(paletteOrId) : paletteOrId;
  const stops = palette.stops.map(hexToRgb);
  const x = clamp01(t) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [
    Math.round(a[0] + f * (b[0] - a[0])),
    Math.round(a[1] + f * (b[1] - a[1])),
    Math.round(a[2] + f * (b[2] - a[2])),
  ];
}

export function rgbCss(rgb, alpha = 1) {
  return alpha === 1
    ? `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`
    : `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

export function scalarToPalette(value, range, paletteOrId) {
  const scale = Math.max(1e-14, range);
  return samplePalette(paletteOrId, 0.5 + 0.5 * Math.max(-1, Math.min(1, value / scale)));
}
