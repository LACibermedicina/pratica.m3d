-- Revalida Prático · esquema PostgreSQL 16
-- Regra central: toda decisão de acesso é conferida no servidor/banco, nunca no cliente.

create extension if not exists pgcrypto;
create extension if not exists citext;

create table if not exists usuarios (
  id            uuid primary key default gen_random_uuid(),
  nome          text not null check (length(nome) >= 2),
  email         citext unique not null,
  senha_hash    text not null,
  papel_app     text not null default 'usuario' check (papel_app in ('usuario','moderador','admin')),
  reputacao     int not null default 0,
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now()
);

create table if not exists tokens_acesso (
  id          uuid primary key default gen_random_uuid(),
  hash        text unique not null,             -- só o hash do token
  tipo        text not null check (tipo in ('master','indicacao','solicitacao')),
  email_preso citext,
  usos_max    int not null default 1,
  usos        int not null default 0,
  expira_em   timestamptz,
  revogado    boolean not null default false,
  criado_em   timestamptz not null default now()
);

create table if not exists estacoes (
  id          uuid primary key default gen_random_uuid(),
  titulo      text not null,
  area        text not null check (area in ('clinica_medica','cirurgia','ginecologia_obstetricia','pediatria','mfc')),
  duracao_min int not null default 10,
  origem      text not null default 'comunidade' check (origem in ('inep','comunidade','ia')),
  status      text not null default 'revisao' check (status in ('rascunho','revisao','aprovada')),
  script_ator text not null default '',
  criado_em   timestamptz not null default now()
);

create table if not exists pep_itens (
  id           uuid primary key default gen_random_uuid(),
  estacao_id   uuid not null references estacoes(id) on delete cascade,
  secao        text not null default 'Geral',
  ordem        int not null default 0,
  descricao    text not null,
  pontos_total numeric(5,2) not null,
  pontos_parcial numeric(5,2),
  critico      boolean not null default false
);

create table if not exists sessoes (
  id              uuid primary key default gen_random_uuid(),
  estacao_id      uuid not null references estacoes(id),
  dono_id         uuid not null references usuarios(id),
  modo            text not null default 'dupla' check (modo in ('solo','dupla')),
  status          text not null default 'aguardando' check (status in ('aguardando','em_andamento','finalizada')),
  canal_video     text unique not null default ('sala-' || gen_random_uuid()::text),
  permite_observadores boolean not null default true,
  max_observadores int not null default 10 check (max_observadores between 0 and 50),
  timer_status    text not null default 'parado' check (timer_status in ('parado','rodando','pausado')),
  timer_inicio_em timestamptz,
  timer_acumulado_ms bigint not null default 0,
  criado_em       timestamptz not null default now()
);

create table if not exists sessao_participantes (
  id         uuid primary key default gen_random_uuid(),
  sessao_id  uuid not null references sessoes(id) on delete cascade,
  usuario_id uuid not null references usuarios(id),
  papel      text not null check (papel in ('candidato','avaliador_ator','observador')),
  entrou_em  timestamptz not null default now(),
  unique (sessao_id, usuario_id)
);
-- vaga principal única por papel
create unique index if not exists uq_papel_principal
  on sessao_participantes (sessao_id, papel) where papel in ('candidato','avaliador_ator');

create table if not exists avaliacoes (
  id           uuid primary key default gen_random_uuid(),
  sessao_id    uuid unique not null references sessoes(id) on delete cascade,
  avaliador_id uuid not null references usuarios(id),
  candidato_id uuid references usuarios(id),
  nota         numeric(6,2),
  nota_max     numeric(6,2),
  finalizada_em timestamptz,
  criado_em    timestamptz not null default now()
);

create table if not exists avaliacao_itens (
  avaliacao_id uuid not null references avaliacoes(id) on delete cascade,
  pep_item_id  uuid not null references pep_itens(id) on delete cascade,
  nivel        text not null check (nivel in ('nao_realizado','parcial','total')),
  pontos       numeric(5,2) not null default 0,
  primary key (avaliacao_id, pep_item_id)
);

create table if not exists comentarios_observador (
  id         uuid primary key default gen_random_uuid(),
  sessao_id  uuid not null references sessoes(id) on delete cascade,
  autor_id   uuid not null references usuarios(id),
  tempo_ms   bigint not null default 0,
  texto      text not null check (length(texto) <= 500),
  criado_em  timestamptz not null default now()
);

create index if not exists ix_part_sessao on sessao_participantes (sessao_id);
create index if not exists ix_pep_estacao  on pep_itens (estacao_id);
create index if not exists ix_coment_sessao on comentarios_observador (sessao_id);

-- ===== 002 · recuperação de senha, root, pedidos e auditoria =====
-- 002 · recuperação de senha, conta root, pedidos de acesso e auditoria.
-- Idempotente: pode rodar em banco novo (já vem no schema.sql) ou em banco existente.

-- papel "root" (um só) e controle de sessão/senha
alter table usuarios drop constraint if exists usuarios_papel_app_check;
alter table usuarios add constraint usuarios_papel_app_check
  check (papel_app in ('usuario','moderador','admin','root'));
alter table usuarios add column if not exists senha_provisoria boolean not null default false;
alter table usuarios add column if not exists sessao_versao   int     not null default 0;   -- sobe a cada troca/redefinição de senha: derruba sessões antigas
alter table usuarios add column if not exists senha_alterada_em timestamptz;
create unique index if not exists uq_um_root on usuarios (papel_app) where papel_app = 'root';

-- links de redefinição de senha (só o hash fica no banco; uso único; vencem)
create table if not exists recuperacoes_senha (
  id         uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references usuarios(id) on delete cascade,
  hash       text unique not null,
  origem     text not null default 'usuario' check (origem in ('usuario','admin')),
  expira_em  timestamptz not null,
  usado_em   timestamptz,
  criado_em  timestamptz not null default now()
);
create index if not exists ix_recup_usuario on recuperacoes_senha (usuario_id, criado_em desc);

-- pedidos de acesso (antes só devolvia uma mensagem e nada era guardado)
create table if not exists solicitacoes_acesso (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null check (length(nome) between 2 and 120),
  email       citext not null,
  mensagem    text check (mensagem is null or length(mensagem) <= 300),
  status      text not null default 'pendente' check (status in ('pendente','aprovada','recusada')),
  decidido_por uuid references usuarios(id) on delete set null,
  decidido_em timestamptz,
  criado_em   timestamptz not null default now()
);
create unique index if not exists uq_pedido_pendente on solicitacoes_acesso (email) where status = 'pendente';

alter table tokens_acesso add column if not exists nota text check (nota is null or length(nota) <= 120);
alter table tokens_acesso add column if not exists criado_por uuid references usuarios(id) on delete set null;

-- trilha de tudo que o painel administrativo faz
create table if not exists auditoria_admin (
  id        bigserial primary key,
  ator_id   uuid references usuarios(id) on delete set null,
  acao      text not null,
  alvo      text,
  detalhes  jsonb not null default '{}',
  criado_em timestamptz not null default now()
);
create index if not exists ix_auditoria_data on auditoria_admin (criado_em desc);
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
