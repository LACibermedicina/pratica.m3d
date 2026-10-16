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
