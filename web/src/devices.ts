// The three devices as drawings, for the front page: the camera, the phone
// app and the glasses. `tone` is the page they sit on.

type Tone = "dark" | "light";

const SHADES = {
  dark: { body: "#1a2342", body2: "#232e55", edge: "#3a4675" },
  light: { body: "#20294a", body2: "#2d3862", edge: "#475488" },
};

export function cameraArt(tone: Tone): string {
  const c = SHADES[tone];
  return `<svg viewBox="0 0 300 210" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A professional camera">
  <defs>
    <linearGradient id="cam-body-${tone}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.body2}"/><stop offset="1" stop-color="${c.body}"/></linearGradient>
    <radialGradient id="cam-lens-${tone}" cx=".42" cy=".38" r=".7"><stop offset="0" stop-color="#5c7bff"/><stop offset=".32" stop-color="#2a2f7a"/><stop offset=".7" stop-color="#0b0f26"/><stop offset="1" stop-color="#05070f"/></radialGradient>
  </defs>
  <path d="M104 38 l10 -22 h74 l10 22z" fill="${c.body2}" stroke="${c.edge}" stroke-width="1.5"/>
  <rect x="46" y="22" width="42" height="14" rx="4" fill="${c.body2}" stroke="${c.edge}" stroke-width="1.5"/>
  <rect x="214" y="24" width="30" height="12" rx="4" fill="${c.body2}" stroke="${c.edge}" stroke-width="1.5"/>
  <circle cx="256" cy="33" r="5" fill="#ff7a2f"/>
  <path d="M34 36 h234 a14 14 0 0 1 14 14 v126 a14 14 0 0 1 -14 14 h-234 a14 14 0 0 1 -14 -14 v-126 a14 14 0 0 1 14 -14z" fill="url(#cam-body-${tone})" stroke="${c.edge}" stroke-width="1.5"/>
  <path d="M20 66 q34 -18 40 36 q2 44 -6 88 h-20 a14 14 0 0 1 -14 -14z" fill="${c.body}" stroke="${c.edge}" stroke-width="1.2" opacity=".9"/>
  <circle cx="162" cy="116" r="72" fill="#0b1022" stroke="${c.edge}" stroke-width="2"/>
  <circle cx="162" cy="116" r="62" fill="#131a36" stroke="#2c365f" stroke-width="1.5"/>
  <circle cx="162" cy="116" r="48" fill="url(#cam-lens-${tone})" stroke="#000" stroke-width="2"/>
  <circle cx="162" cy="116" r="23" fill="#070a18" opacity=".78"/>
  <ellipse cx="146" cy="98" rx="11" ry="7" fill="#fff" opacity=".35" transform="rotate(-30 146 98)"/>
  <circle cx="162" cy="116" r="66.5" fill="none" stroke="#7b5cff" stroke-width="1.3" opacity=".75"/>
</svg>`;
}

export function phoneArt(tone: Tone): string {
  const c = SHADES[tone];
  return `<svg viewBox="0 0 130 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A phone running the Shutter Sense app">
  <rect x="4" y="3" width="122" height="244" rx="22" fill="${c.body}" stroke="${c.edge}" stroke-width="2"/>
  <rect x="11" y="10" width="108" height="230" rx="16" fill="#f6f8ff"/>
  <rect x="50" y="17" width="30" height="6" rx="3" fill="#0d1530"/>
  <circle cx="26" cy="38" r="8" fill="#3355ff"/><rect x="22" y="35" width="8" height="6" rx="1.5" fill="#fff"/>
  <rect x="40" y="32" width="46" height="5" rx="2.5" fill="#0d1530"/><rect x="40" y="41" width="30" height="3.5" rx="1.75" fill="#b6bfd9"/>
  <rect x="18" y="56" width="94" height="24" rx="9" fill="#3355ff"/><rect x="26" y="63" width="66" height="4" rx="2" fill="#fff"/><rect x="26" y="70" width="42" height="4" rx="2" fill="#fff" opacity=".8"/>
  <rect x="18" y="88" width="94" height="22" rx="8" fill="#fff1e5"/><rect x="26" y="95" width="58" height="4" rx="2" fill="#d65a12"/><rect x="26" y="102" width="36" height="3.5" rx="1.75" fill="#d65a12" opacity=".6"/>
  <rect x="18" y="118" width="94" height="72" rx="9" fill="#0d1530"/>
  <path d="M18 172 l24 -22 18 14 16 -18 36 30 v5 a9 9 0 0 1 -9 9 h-76 a9 9 0 0 1 -9 -9z" fill="#3355ff" opacity=".75"/>
  <circle cx="92" cy="136" r="9" fill="#ff7a2f"/>
  <rect x="18" y="198" width="60" height="22" rx="11" fill="#eaf0ff"/><rect x="84" y="198" width="28" height="22" rx="11" fill="#7b5cff"/>
</svg>`;
}

export function glassesArt(tone: Tone): string {
  const c = SHADES[tone];
  return `<svg viewBox="0 0 320 130" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Ray-Ban Display glasses with a small display in the right lens">
  <path d="M6 42 q2 -10 16 -10 l26 2 M314 42 q-2 -10 -16 -10 l-26 2" fill="none" stroke="${c.body2}" stroke-width="9" stroke-linecap="round"/>
  <path d="M26 30 h104 a14 14 0 0 1 14 14 q0 2 -.3 4 l-8 44 a24 24 0 0 1 -23.6 20 h-58 a24 24 0 0 1 -23.8 -21 l-8 -46 q-1 -15 13.1 -15z" fill="#10172f" stroke="#26304f" stroke-width="10" stroke-linejoin="round"/>
  <path d="M294 30 h-104 a14 14 0 0 0 -14 14 q0 2 .3 4 l8 44 a24 24 0 0 0 23.6 20 h58 a24 24 0 0 0 23.8 -21 l8 -46 q1 -15 -13.1 -15z" fill="#10172f" stroke="#26304f" stroke-width="10" stroke-linejoin="round"/>
  <path d="M144 46 q16 -10 32 0" fill="none" stroke="#26304f" stroke-width="10"/>
  <path d="M34 42 l30 0 -22 60 q-8 -2 -10 -14z" fill="#fff" opacity=".05"/>
  <rect x="222" y="48" width="58" height="42" rx="7" fill="#000" stroke="#7b5cff" stroke-width="1.5"/>
  <rect x="228" y="55" width="30" height="3.4" rx="1.7" fill="#7ee7c3"/>
  <rect x="228" y="62" width="44" height="3" rx="1.5" fill="#ffb86b"/>
  <rect x="228" y="69" width="38" height="3" rx="1.5" fill="#fff" opacity=".8"/>
  <rect x="228" y="78" width="46" height="7" rx="2" fill="none" stroke="#ffb86b" stroke-width="1"/>
</svg>`;
}
