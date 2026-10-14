#!/usr/bin/env python3
"""Semente do Revalida Prático: estações de exemplo com PEP e um token de demonstração.

Uso:
    pip install "psycopg[binary]"
    python python/seed.py          # usa DATABASE_URL ou o padrão local
"""
import hashlib
import os
import sys

import psycopg

DSN = os.environ.get("DATABASE_URL", "postgres://revalida:revalida@localhost:5432/revalida")
TOKEN_DEMO = os.environ.get("TOKEN_DEMO", "REVALIDA-DEMO-2026")  # só para testes locais

ESTACOES = [
    {
        "titulo": "Dor torácica na UBS",
        "area": "clinica_medica",
        "duracao_min": 10,
        "script_ator": "Homem, 52 anos, dor torácica em aperto há 40 minutos, irradiando para o braço esquerdo. Sudorese e náusea. Nega trauma.",
        "pep": [
            ("Anamnese", "Apresenta-se e confirma a identificação do paciente", 1.0, None, False),
            ("Anamnese", "Caracteriza a dor: local, irradiação, intensidade e duração", 1.0, 0.5, False),
            ("Conduta", "Solicita eletrocardiograma imediato", 1.5, 0.75, True),
            ("Conduta", "Prescreve AAS e encaminha ao serviço de emergência", 1.5, 0.75, True),
            ("Comunicação", "Explica a suspeita diagnóstica ao paciente com linguagem clara", 1.0, 0.5, False),
        ],
    },
    {
        "titulo": "Cefaleia na emergência",
        "area": "clinica_medica",
        "duracao_min": 10,
        "script_ator": "Mulher, 34 anos, cefaleia holocraniana de início súbito há 2 horas, 'a pior da vida'. Sem febre.",
        "pep": [
            ("Anamnese", "Investiga início súbito, intensidade e sintomas associados", 1.0, 0.5, False),
            ("Exame", "Realiza exame neurológico direcionado (sinais meníngeos, déficits focais)", 1.5, 0.75, True),
            ("Conduta", "Solicita TC de crânio sem contraste", 1.5, 0.75, True),
            ("Comunicação", "Informa necessidade de investigação de hemorragia subaracnóidea", 1.0, 0.5, False),
        ],
    },
    {
        "titulo": "Pré-natal: consulta de rotina",
        "area": "ginecologia_obstetricia",
        "duracao_min": 10,
        "script_ator": "Gestante de 28 semanas, primeiro pré-natal na unidade. Sem queixas.",
        "pep": [
            ("Anamnese", "Calcula idade gestacional e verifica cartão de pré-natal", 1.0, 0.5, False),
            ("Exame", "Aferi PA, mede altura uterina e ausculta BCF", 1.5, 0.75, True),
            ("Conduta", "Solicita exames do trimestre e atualiza vacinas", 1.0, 0.5, False),
            ("Comunicação", "Orienta sinais de alarme e agenda retorno", 1.0, 0.5, False),
        ],
    },
    {
        "titulo": "Diarreia aguda em lactente",
        "area": "pediatria",
        "duracao_min": 8,
        "script_ator": "Mãe de lactente de 8 meses com diarreia há 2 dias, 6 evacuações/dia. Aceita pouco líquido.",
        "pep": [
            ("Anamnese", "Avalia sinais de desidratação e aceitação de líquidos", 1.5, 0.75, True),
            ("Conduta", "Prescreve SRO conforme plano de hidratação", 1.5, 0.75, True),
            ("Comunicação", "Ensina a mãe sinais de piora e retorno", 1.0, 0.5, False),
            ("Comunicação", "Reforça manutenção do aleitamento materno", 1.0, 0.5, False),
        ],
    },
    {
        "titulo": "Ferida abdominal pós-apendicectomia",
        "area": "cirurgia",
        "duracao_min": 8,
        "script_ator": "Homem, 27 anos, 3º dia de pós-operatório de apendicectomia, dor e secreção na ferida.",
        "pep": [
            ("Exame", "Inspeciona a ferida: bordas, secreção, sinais flogísticos", 1.5, 0.75, True),
            ("Conduta", "Realiza curativo com técnica asséptica", 1.0, 0.5, False),
            ("Conduta", "Suspeita de infecção de sítio cirúrgico e define conduta", 1.0, 0.5, False),
            ("Comunicação", "Orienta cuidados com a ferida no domicílio", 1.0, 0.5, False),
        ],
    },
]

AREAS = {e["area"] for e in ESTACOES}


def main() -> int:
    with psycopg.connect(DSN, autocommit=True) as conn:
        with conn.cursor() as cur:
            for est in ESTACOES:
                cur.execute(
                    """insert into estacoes (titulo, area, duracao_min, origem, status, script_ator)
                       values (%s,%s,%s,'inep','aprovada',%s)
                       on conflict do nothing returning id""",
                    (est["titulo"], est["area"], est["duracao_min"], est["script_ator"]),
                )
                row = cur.fetchone()
                if not row:
                    cur.execute("select id from estacoes where titulo=%s", (est["titulo"],))
                    row = cur.fetchone()
                estacao_id = row[0]
                for ordem, (secao, descricao, total, parcial, critico) in enumerate(est["pep"]):
                    cur.execute(
                        """insert into pep_itens (estacao_id, secao, ordem, descricao, pontos_total, pontos_parcial, critico)
                           values (%s,%s,%s,%s,%s,%s,%s) on conflict do nothing""",
                        (estacao_id, secao, ordem, descricao, total, parcial, critico),
                    )
            # token de demonstração (uso múltiplo, 30 dias) — só hash no banco
            cur.execute(
                """insert into tokens_acesso (hash, tipo, usos_max, expira_em)
                   values (%s,'indicacao',50, now() + interval '30 days') on conflict do nothing""",
                (hashlib.sha256(TOKEN_DEMO.encode()).hexdigest(),),
            )
    print(f"OK: {len(ESTACOES)} estações semeadas em {len(AREAS)} áreas.")
    print(f"Token de demonstração (30 dias, 50 usos): {TOKEN_DEMO}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
