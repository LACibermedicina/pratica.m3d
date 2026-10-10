'use strict';
/** Logo pratica.M3D — SVG escrito à mão (sem imagem externa). */
export function m3dLogo(size = 44) {
  return `<svg class="m3d-logo" viewBox="0 0 120 120" width="${size}" height="${size}" role="img" aria-label="pratica.M3D">
    <defs>
      <linearGradient id="mg1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5eead4"/><stop offset="1" stop-color="#2dd4bf"/></linearGradient>
      <linearGradient id="mg2" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="#14b8a6"/><stop offset="1" stop-color="#0d9488"/></linearGradient>
      <linearGradient id="mg3" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f766e"/><stop offset="1" stop-color="#115e59"/></linearGradient>
    </defs>
    <rect width="120" height="120" rx="26" fill="#EEFBFB"/>
    <g class="cube">
      <polygon points="86,26 104,36 104,84 86,74" fill="url(#mg1)"/>
      <polygon points="68,36 86,26 86,74 68,84" fill="url(#mg2)"/>
      <polygon points="86,74 104,84 86,94 68,84" fill="url(#mg3)"/>
      <polygon points="60,52 72,44 72,96 60,104" fill="#095954"/>
      <polygon points="16,42 38,30 60,42 38,54" fill="url(#mg1)"/>
      <polygon points="16,42 38,54 38,90 16,78" fill="url(#mg3)"/>
      <polygon points="38,54 60,42 60,78 38,90" fill="url(#mg2)"/>
      <g fill="#fff" transform="translate(49,78) skewY(-16)">
        <rect x="-5" y="-18" width="10" height="22" rx="3.5"/>
        <rect x="-11" y="-11" width="22" height="9" rx="3.5"/>
      </g>
    </g>
  </svg>`;
}
