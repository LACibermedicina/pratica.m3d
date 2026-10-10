<?php
declare(strict_types=1);

/** Marca pratica.M3D — símbolo vetorial (SVG) reconstruído a partir do logo anexado.
 *  Nenhuma imagem externa: o cubo 3D é escrito à mão, com gradientes e animação. */
function m3d_logo(string $id = 'a', int $size = 44): string
{
    $g1 = "grad-$id-1"; $g2 = "grad-$id-2"; $g3 = "grad-$id-3";
    $sh = "sh-$id";
    return <<<SVG
<svg class="m3d-logo" viewBox="0 0 120 120" width="{$size}" height="{$size}" role="img" aria-label="pratica.M3D">
  <defs>
    <linearGradient id="{$g1}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5eead4"/><stop offset="1" stop-color="#2dd4bf"/>
    </linearGradient>
    <linearGradient id="{$g2}" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="#14b8a6"/><stop offset="1" stop-color="#0d9488"/>
    </linearGradient>
    <linearGradient id="{$g3}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0f766e"/><stop offset="1" stop-color="#115e59"/>
    </linearGradient>
    <filter id="{$sh}" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="5" stdDeviation="6" flood-color="#0f766e" flood-opacity="0.28"/>
    </filter>
  </defs>
  <g class="m3d-cube" filter="url(#{$sh})">
    <!-- face superior do cubo principal -->
    <polygon points="12,42 46,24 60,34 26,52"   fill="url(#{$g1})"/>
    <!-- face frontal esquerda -->
    <polygon points="12,42 26,52 26,92 12,82"   fill="#0f766e" opacity="0.92"/>
    <!-- face frontal -->
    <polygon points="26,52 60,34 60,74 26,92"   fill="url(#{$g2})"/>
    <!-- face direita -->
    <polygon points="60,34 94,52 60,74"          fill="#0d9488"/>
    <polygon points="60,74 94,52 94,92 60,110"   fill="url(#{$g3})"/>
    <!-- cubo satélite (M3D) -->
    <polygon points="80,20 108,34 108,78 80,92"  fill="#14b8a6" opacity="0.96"/>
    <polygon points="80,20 108,34 80,48"          fill="#99f6e4" opacity="0.92"/>
    <polygon points="80,48 108,34 108,78 80,92"  fill="#0d9488" opacity="0.42"/>
  </g>
  <!-- cruz da saúde: identidade médica -->
  <g class="m3d-cross" opacity="0.95">
    <rect x="37" y="58" width="12" height="4" rx="2" fill="#ecfeff"/>
    <rect x="41" y="54" width="4" height="12" rx="2" fill="#ecfeff"/>
  </g>
</svg>
SVG;
}

/** Marca compacta para o cabeçalho das seções. */
function m3d_mark(int $size = 30): string
{
    return m3d_logo('mk', $size);
}
