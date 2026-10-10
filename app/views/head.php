<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>pratica.M3D v5 — Treino OSCE / Revalida</title>
<meta name="description" content="Plataforma de treino OSCE/Revalida: videochamada WebRTC, PEP com correção por IA e disputa, SRS e cards de procedimento."/>
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml"/>
<script src="https://cdn.tailwindcss.com"></script>
<script>
  tailwind.config = {
    theme: {
      extend: {
        colors: {
          teal1: '#0d9488', teal2: '#14b8a6', teal3: '#5eead4', teal4: '#2dd4bf', deep: '#0f766e',
          coral: '#fb7185', amberx: '#fbbf24', violetx: '#8b5cf6', skyx: '#38bdf8', limex: '#a3e635',
          ink: '#134e4a', mut: '#5b7d78', line: '#ccfbf1'
        },
        fontFamily: { round: ["ui-rounded", "Segoe UI", "system-ui", "sans-serif"] },
        boxShadow: { soft: '0 10px 30px rgba(13,148,136,.14)', glow: '0 0 0 4px rgba(45,212,191,.25)' }
      }
    }
  }
</script>
<link rel="stylesheet" href="/assets/app.css"/>
</head>
<body class="font-round text-ink">

<!-- ============================ LOGO VETORIAL ============================
     O símbolo é um SVG escrito no servidor (app/logo.php): cubo 3D translúcido
     com gradientes teal + cruz da saúde. Não há nenhum arquivo de imagem.  -->
<header id="topbar" class="sticky top-0 z-40 backdrop-blur bg-white/70 border-b border-line">
  <div class="mx-auto max-w-[1500px] px-4 py-3 flex items-center gap-3">
    <button type="button" id="brandBtn" class="flex items-center gap-3 shrink-0" title="Ir ao painel">
      <?= m3d_logo('nav', 46) ?>
      <span class="brand-text">
        <span class="brand-line block text-[21px] font-black leading-none text-deep">pratica<span class="text-teal1">.M3D</span></span>
        <span class="block text-[10.5px] font-bold tracking-[0.16em] text-mut">OSCE · REVALIDA v5</span>
      </span>
    </button>

    <div class="ml-auto flex items-center gap-2">
      <span id="liveBadge" class="hidden items-center gap-1.5 rounded-full bg-coral/15 px-3 py-1 text-[11px] font-black text-coral">
        <span class="live-dot"></span> AO VIVO
      </span>
      <button id="aiBadge" type="button" class="hidden rounded-full bg-teal1/10 px-3 py-1 text-[11px] font-black text-deep" title="Provedor de IA em uso">
        🤖 <span id="aiBadgeText">—</span>
      </button>
      <span id="clockBadge" class="hidden rounded-full bg-violetx/10 px-3 py-1 text-[11px] font-black text-violetx tabular-nums">⏱ 10:00</span>
      <span id="userChip" class="hidden items-center gap-2 rounded-full border border-line bg-white px-2.5 py-1 text-[12px] font-bold cursor-pointer" title="Meu perfil">
        <span id="userAvatar">🩺</span><span id="userName">—</span>
      </span>
      <button id="btnLogout" class="btn ghost hidden !py-1.5 !px-3 text-[12px]">Sair</button>
      <button id="btnMenu" class="btn ghost !py-1.5 !px-3 text-[12px]" title="Menu">☰</button>
    </div>
  </div>

  <nav id="mainnav" class="mx-auto max-w-[1500px] px-4 pb-2 flex flex-wrap gap-1.5 text-[12.5px] font-bold"></nav>
</header>
