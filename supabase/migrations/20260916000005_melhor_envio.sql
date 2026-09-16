-- ----------------------------------------------------------------------------
-- Integração Melhor Envio — só puxa o custo real da etiqueta, não compra.
--
-- melhor_envio_tokens: token OAuth (renovado sozinho pela function antes de
-- expirar). Nunca exposto ao client — sem grant pra authenticated, só
-- service_role mexe aqui.
--
-- melhor_envio_shipments: uma linha por etiqueta que o webhook recebeu.
-- O Melhor Envio não guarda referência externa (não dá pra anexar o
-- shopify_order_id do lado deles), então a etiqueta chega "solta" e o
-- admin confirma manualmente qual pedido é aquele (por CEP, nome do
-- destinatário, data). Confirmado, o custo vai pra order_shipping.cost —
-- é isso que a view sale_margin já usa como shipping_cost.
-- ----------------------------------------------------------------------------
create table if not exists melhor_envio_tokens (
  id int primary key default 1,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint melhor_envio_tokens_single_row check (id = 1)
);

alter table melhor_envio_tokens enable row level security;
-- Sem policy nenhuma: só a Service Role (que ignora RLS) lê/escreve.

create table if not exists melhor_envio_shipments (
  id uuid primary key default gen_random_uuid(),
  melhor_envio_id text not null unique,
  protocol text,
  status text not null,
  price numeric(10,2),
  recipient_name text,
  recipient_zipcode text,
  tracking_code text,
  event_received_at timestamptz not null default now(),
  matched_shopify_order_id bigint references order_shipping(shopify_order_id) on delete set null,
  matched_at timestamptz
);

alter table melhor_envio_shipments enable row level security;

drop policy if exists melhor_envio_shipments_admin_all on melhor_envio_shipments;
create policy melhor_envio_shipments_admin_all on melhor_envio_shipments
  for all using (is_admin_user()) with check (is_admin_user());

notify pgrst, 'reload schema';
