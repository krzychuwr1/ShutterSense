// The brand mark and the page's SVG sprite: icons are drawn once here and
// referenced with <use>, on the front page and in the simulated experience.

import { h } from "./dom.ts";

const SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="logoGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3355ff"/><stop offset="1" stop-color="#7b5cff"/></linearGradient>
    <symbol id="logo" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="16" fill="url(#logoGrad)"/>
      <rect x="10" y="20" width="44" height="30" rx="7" fill="none" stroke="#fff" stroke-width="4"/>
      <path d="M22 20l4-6h12l4 6" fill="none" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>
      <circle cx="32" cy="35" r="8" fill="none" stroke="#fff" stroke-width="4"/>
      <circle cx="46" cy="27" r="2.6" fill="#ffab4a"/>
    </symbol>
    <filter id="motionBlur" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="2.6 0"/></filter>
    <symbol id="i-arrow" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></symbol>
    <symbol id="i-back" viewBox="0 0 24 24"><path d="M19 12H5M11 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></symbol>
    <symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>
    <symbol id="i-mic" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
    <symbol id="i-play" viewBox="0 0 24 24"><path d="M7 5v14l12-7z" fill="currentColor"/></symbol>
    <symbol id="i-pause" viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1.2" fill="currentColor"/></symbol>
    <symbol id="i-cam" viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="13" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 7l1.6-3h4.8L16 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="13.5" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/></symbol>
    <symbol id="i-phone" viewBox="0 0 24 24"><rect x="6" y="2.5" width="12" height="19" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10.5 18.5h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
    <symbol id="i-cloud" viewBox="0 0 24 24"><path d="M7 19h10.5a4.5 4.5 0 0 0 .4-9A6.5 6.5 0 0 0 5.6 9.2 5 5 0 0 0 7 19z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></symbol>
    <symbol id="i-glasses" viewBox="0 0 24 24"><path d="M2 9h20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="3" y="9" width="7.5" height="7" rx="2.6" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13.5" y="9" width="7.5" height="7" rx="2.6" fill="none" stroke="currentColor" stroke-width="2"/><rect x="15.5" y="11" width="3.5" height="2.2" rx=".6" fill="currentColor"/></symbol>
    <symbol id="i-drag" viewBox="0 0 24 24"><path d="M9 6l-6 6 6 6M15 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>
    <symbol id="i-wifi" viewBox="0 0 24 24"><path d="M2.5 9a14 14 0 0 1 19 0M5.8 12.6a9.2 9.2 0 0 1 12.4 0M9.2 16.1a4.4 4.4 0 0 1 5.6 0" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="19.4" r="1.5" fill="currentColor"/></symbol>
    <symbol id="i-tap" viewBox="0 0 24 24"><path d="M9 11V5.5a1.8 1.8 0 0 1 3.6 0V11m0-1.2a1.8 1.8 0 0 1 3.6 0V12m0-1a1.8 1.8 0 0 1 3.6 0v3.5A6.5 6.5 0 0 1 13.3 21h-1a6 6 0 0 1-4.6-2.2L4.6 15a1.9 1.9 0 0 1 2.8-2.5L9 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
    <symbol id="i-chevron" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  </defs>
</svg>`;

/** The sprite every <use href="#…"> on the page points at. Add it to the page once. */
export const sprite = () => h(SPRITE);

/** Markup for a sprite icon. */
export const use = (id: string, cls = "") => `<svg${cls ? ` class="${cls}"` : ""} aria-hidden="true"><use href="#${id}"/></svg>`;

/** A sprite icon as an element. */
export const icon = (id: string, cls = "") => h(use(id, cls));
