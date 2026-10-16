-- 003: configuração do servidor (instalador) e áudio de observadores controlado pelo chefe da sala.
-- Idempotente: pode rodar de novo sem efeito.

-- Parâmetros do servidor definidos no instalador. Valores secretos ficam CIFRADOS (AES-256-GCM, chave derivada de JWT_SEGREDO).
-- Variáveis de ambiente sempre têm prioridade sobre esta tabela.
create table if not exists config_servidor (
  chave          text primary key check (length(chave) between 1 and 60),
  valor          text not null,
  segredo        boolean not null default false,
  atualizado_em  timestamptz not null default now()
);

-- Áudio de observadores: por padrão NÃO é permitido. Só o chefe da sala (avaliador/ator) altera.
alter table sessoes add column if not exists audio_observadores boolean not null default false;
