
<main class="mx-auto max-w-[1500px] px-4 py-5">

  <!-- ================================ AUTENTICAÇÃO ============================ -->
  <section id="view-auth" class="hidden">
    <div class="grid gap-5 lg:grid-cols-[1.05fr_1fr] items-stretch">
      <div class="card hero-card">
        <div class="flex items-center gap-4">
          <?= m3d_logo('hero', 88) ?>
          <div>
            <div class="text-[30px] font-black leading-none text-deep">pratica<span class="text-teal1">.M3D</span></div>
            <div class="text-[12px] font-black tracking-[0.18em] text-mut">SIMULAÇÃO OSCE · REVALIDA</div>
          </div>
        </div>
        <p class="mt-4 text-[14.5px] leading-relaxed">
          Treine estações reais em <b>videochamada</b> com correção de PEP por <b>IA</b>, grafique seu
          desempenho por grande área e transforme cada critério do checklist em
          <b>card de procedimento com fluxograma</b> do Ministério da Saúde.
        </p>
        <div class="mt-5 grid grid-cols-2 gap-2.5 text-[12px]">
          <div class="pill animate-float">🎥 WebRTC mesh + SDP manual</div>
          <div class="pill animate-float" style="animation-delay:.4s">🤖 IA em cadeia de failsafe</div>
          <div class="pill animate-float" style="animation-delay:.8s">⏱ Timer autoritativo</div>
          <div class="pill animate-float" style="animation-delay:1.2s">🧠 SRS 1·3·7·15·30 dias</div>
        </div>
        <div id="authStats" class="mt-5 grid grid-cols-3 gap-2 text-center"></div>
      </div>

      <div class="card">
        <div class="flex gap-1.5 rounded-2xl bg-teal1/8 p-1.5 text-[13px] font-bold">
          <button class="tabbtn flex-1" data-authtab="login">Entrar</button>
          <button class="tabbtn flex-1" data-authtab="register">Criar conta</button>
          <button class="tabbtn flex-1" data-authtab="forgot">Recuperar</button>
        </div>

        <form id="formLogin" class="mt-4 space-y-3">
          <label class="fl">E-mail<input class="in" type="email" name="email" autocomplete="username" required placeholder="voce@email.com"/></label>
          <label class="fl">Senha<input class="in" type="password" name="pass" autocomplete="current-password" required placeholder="••••••"/></label>
          <button class="btn w-full">Entrar</button>
          <p class="hint">Sessão de até 30 dias (Bearer Token).</p>
        </form>

        <form id="formRegister" class="mt-4 space-y-3 hidden">
          <label class="fl">Nome completo<input class="in" name="name" required placeholder="Como apareço nas salas"/></label>
          <label class="fl">E-mail<input class="in" type="email" name="email" required/></label>
          <label class="fl">Senha (mín. 6)<input class="in" type="password" name="pass" required/></label>
          <button class="btn w-full">Criar minha conta</button>
          <p class="hint">Senha protegida com bcrypt no servidor.</p>
        </form>

        <form id="formForgot" class="mt-4 space-y-3 hidden">
          <label class="fl">E-mail da conta<input class="in" type="email" name="email" required/></label>
          <button class="btn w-full">Emitir token de redefinição</button>
          <div id="forgotOut" class="hidden rounded-xl border border-line bg-teal1/5 p-3 text-[12px]"></div>
        </form>

        <form id="formReset" class="mt-4 space-y-3 hidden">
          <label class="fl">Token<input class="in" name="token" required placeholder="cole o token"/></label>
          <label class="fl">Nova senha<input class="in" type="password" name="pass" required/></label>
          <button class="btn w-full">Redefinir senha</button>
        </form>

        <div id="authMsg" class="mt-3 text-[12.5px] font-bold"></div>
      </div>
    </div>
  </section>

  <!-- ================================== PAINEL =============================== -->
  <section id="view-app" class="hidden">
    <div id="tabhost" class="space-y-5"></div>
  </section>
</main>

<!-- =========================== MODAL GENÉRICO =========================== -->
<div id="modal" class="fixed inset-0 z-[70] hidden">
  <div class="absolute inset-0 bg-deep/45 backdrop-blur-sm" data-close="1"></div>
  <div class="relative mx-auto mt-[4vh] w-[min(1000px,94vw)] max-h-[92vh] overflow-auto card !p-0">
    <div class="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-white/95 px-5 py-3 backdrop-blur">
      <span id="modalIcon">📄</span>
      <h3 id="modalTitle" class="text-[16px] font-black text-deep">Detalhes</h3>
      <button class="ml-auto btn ghost !py-1.5 !px-3 text-[12px]" data-close="1">✕ Fechar</button>
    </div>
    <div id="modalBody" class="p-5"></div>
  </div>
</div>

<!-- ======================= DESEMPENHO / GRÁFICOS ======================= -->
<div id="imgview" class="fixed inset-0 z-[80] hidden items-center justify-center bg-deep/70 p-4">
  <div class="max-h-[94vh] w-[min(1100px,96vw)] overflow-auto rounded-2xl bg-white p-4">
    <div class="mb-3 flex items-center gap-2">
      <span class="text-[14px] font-black text-deep">Card de procedimento</span>
      <button class="ml-auto btn ghost !py-1.5 !px-3 text-[12px]" id="imgClose">✕ Fechar</button>
      <button class="btn !py-1.5 !px-3 text-[12px]" id="imgPrint">🖨 Imprimir / PDF</button>
    </div>
    <div id="imgSlot"></div>
  </div>
</div>

<div id="toasts" class="fixed bottom-4 right-4 z-[90] space-y-2"></div>

<script src="/assets/app.js"></script>
