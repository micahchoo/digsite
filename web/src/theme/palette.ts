// The canvases cannot read `var(--accent)`: canvas 2D takes a resolved
// colour string and deck.gl takes an RGBA array. This reads the tokens in
// tokens.css once per theme, so the board map and the sheet scene draw
// with the same colours as the chrome around them. tokens.css stays the
// only place a colour is written.
import { useEffect, useState } from 'react';

export type RGBA = [number, number, number, number];

export interface Palette {
  canvas: string;
  accent: string;
  textPrimary: string;
  textSecondary: string;
  line: string;
  lineStrong: string;
  claimOwn: string;
  claimEdge: string;
  placeholder: string;
}

const TOKENS: Record<keyof Palette, string> = {
  canvas: '--surface-canvas',
  accent: '--accent',
  textPrimary: '--text-primary',
  textSecondary: '--text-secondary',
  line: '--line',
  lineStrong: '--line-strong',
  claimOwn: '--claim-own',
  claimEdge: '--claim-edge',
  placeholder: '--placeholder',
};

export function readPalette(root: Element = document.documentElement): Palette {
  const style = getComputedStyle(root);
  const out = {} as Palette;
  for (const [key, token] of Object.entries(TOKENS) as [
    keyof Palette,
    string,
  ][]) {
    out[key] = style.getPropertyValue(token).trim();
  }
  return out;
}

/** `#rrggbb` → deck.gl RGBA. The palette's tokens are all six-digit hex. */
export function rgba(hex: string, alpha = 255): RGBA {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  if (Number.isNaN(n)) return [0, 0, 0, alpha];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha];
}

/** `#rrggbb` → a canvas 2D colour string at `alpha` in 0..1. */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = rgba(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** The palette now, re-read when the system scheme or `data-theme` changes. */
export function usePalette(): Palette {
  const [palette, setPalette] = useState(readPalette);
  useEffect(() => {
    const refresh = () => setPalette(readPalette());
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', refresh);
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => {
      media.removeEventListener('change', refresh);
      observer.disconnect();
    };
  }, []);
  return palette;
}
