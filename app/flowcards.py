"""Cards de resumo com fluxogramas didáticos (PNG gerado no servidor, offline).
O 'spec' (título + passos) vem da IA; se a IA falhar, usa-se o template XABCDE.
Renderização determinística via matplotlib — nada depende de IA de imagem."""
import os, json, textwrap, time, urllib.parse
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, 'static', 'flowcards')
os.makedirs(OUT, exist_ok=True)

COLORS = {'inicio': '#0d9488', 'avaliacao': '#0284c7', 'conduta': '#d97706',
          'alerta': '#e11d48', 'reavaliacao': '#7c3aed', 'default': '#0d9488'}

def cover_url(tema):
    """Capa ilustrativa por IA de imagem (Pollinations, gratuito, sem chave)."""
    p = urllib.parse.quote(f"flat medical education illustration, teal palette: {tema}")
    return f"https://image.pollinations.ai/prompt/{p}?width=640&height=360&nologo=true"

def fallback_spec(tema):
    return {"title": f"Abordagem — {tema}", "fonte": "Template XABCDE / protocolos Ministério da Saúde",
            "steps": [
        {"kind": "inicio", "label": "X — Vias aéreas com controle de coluna", "detail": "Verificar perviedade; aspirar/intubar se necessário"},
        {"kind": "avaliacao", "label": "A/B — Respiração e ventilação", "detail": "FR, SatO2, ausculta; O2 conforme protocolo"},
        {"kind": "conduta", "label": "C — Circulação e controle de hemorragias", "detail": "2 acessos venosos, cristaloide, monitorizar"},
        {"kind": "avaliacao", "label": "D — Avaliação neurológica", "detail": "Glasgow, pupilas, glicemia capilar"},
        {"kind": "avaliacao", "label": "E — Exposição e exame completo", "detail": "Prevenir hipotermia; buscar lesões"},
        {"kind": "conduta", "label": "Conduta específica do tema", "detail": "Seguir protocolo/diretriz do Ministério da Saúde"},
        {"kind": "reavaliacao", "label": "Reavaliação seriada e referência", "detail": "Reavaliar sinais vitais; encaminhar se critério"}]}

def render_png(spec, fid):
    steps = (spec.get('steps') or [])[:10] or fallback_spec('')['steps']
    title = str(spec.get('title') or 'Fluxograma')[:90]
    n = len(steps)
    fig, ax = plt.subplots(figsize=(8, 2.0 + n * 1.45), dpi=160)
    ax.set_xlim(0, 10); ax.set_ylim(0, n * 1.45 + 2.6); ax.axis('off')
    fig.patch.set_facecolor('#f0fdfa')
    ax.text(5, n * 1.45 + 2.1, textwrap.fill(title, 52), ha='center', va='center',
            fontsize=14, fontweight='bold', color='#0f766e')
    for i, st in enumerate(steps):
        y = n * 1.45 - i * 1.45
        color = COLORS.get(str(st.get('kind', 'default')), COLORS['default'])
        ax.add_patch(FancyBboxPatch((1.1, y - 0.52), 7.8, 1.08,
                                    boxstyle="round,pad=0.12", fc=color, ec='none', alpha=.93))
        ax.text(5, y + 0.14, textwrap.fill(str(st.get('label', ''))[:120], 46),
                ha='center', va='center', fontsize=10, fontweight='bold', color='white')
        if st.get('detail'):
            ax.text(5, y - 0.24, textwrap.fill(str(st['detail'])[:160], 78),
                    ha='center', va='center', fontsize=7.4, color='#ecfeff')
        if i < n - 1:
            ax.add_patch(FancyArrowPatch((5, y - 0.58), (5, y - 0.92),
                                         arrowstyle='-|>', mutation_scale=17,
                                         color='#0f766e', lw=2))
    ax.text(5, 0.4, textwrap.fill('Fonte: ' + str(spec.get('fonte',
            'Diretrizes do Ministério da Saúde / protocolos vigentes')), 100),
            ha='center', fontsize=7, color='#5b7d78')
    path = os.path.join(OUT, fid + '.png')
    fig.savefig(path, bbox_inches='tight', facecolor=fig.get_facecolor())
    plt.close(fig)
    return '/static/flowcards/' + fid + '.png'
