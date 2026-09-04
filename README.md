# Shadow of the Fallen - Jackpot

Adaptado do projeto irmão **Mental Madness — Jackpot**, mesma arquitetura,
uma loja Shopify só. Calcula a margem real de cada venda (faturamento →
custo direto → custos da venda → marketing rateado → fixos rateados →
lucro líquido).

Stack: Vite + React 19 + TypeScript + react-router-dom + @supabase/supabase-js.

## Estado atual

Este repositório é só o **código**, adaptado pra uma loja só (sem o
conceito de "linha de produto" do projeto original, que existia porque
lá tinha duas lojas Shopify diferentes). Faltam os passos de infra —
nenhum deles foi feito ainda:

- [ ] Criar o app customizado na loja Shopify (`Configurações → Apps →
      Desenvolver apps`), pegar Client ID/Secret.
- [ ] Criar um projeto Supabase novo (separado do Mental Jackpot).
- [ ] Rodar a migration `supabase/migrations/20260819000001_init.sql`
      nesse projeto novo (`npx supabase db push`).
- [ ] Configurar os secrets da function (ver seções abaixo).
- [ ] Deploy das três edge functions.
- [ ] Registrar os webhooks na Shopify.
- [ ] Deploy do frontend (Vercel ou outro), com `.env` apontando pro
      Supabase novo.
- [ ] Trocar a logo (`public/logo-m.png`) e as URLs do `index.html`
      (`og:image`, `og:url`) pelas de verdade.
- [ ] Inserir o(s) e-mail(s) de admin em `admin_emails` (a migration
      deixou um `insert` comentado no final, só descomentar e ajustar).

## Criar acesso pra alguém

Sem cadastro aberto na tela de login (self-signup desligado de
propósito — só o admin cria conta). Pra dar acesso a alguém:

1. No painel do Supabase: **Authentication → Users → Add user**, criar o
   usuário com e-mail e senha.
2. Inserir esse mesmo e-mail na tabela `admin_emails` (via SQL Editor, ou
   `npx supabase db query --linked --file <arquivo.sql>` com
   `insert into admin_emails (email) values ('...');`).
3. A pessoa entra em `/login` com e-mail e senha normalmente.

Estar logado não basta — o e-mail precisa estar em `admin_emails` **e**
"Allow new users to sign up" precisa estar desligado em Authentication →
Sign In / Providers → Email.

## Rodar localmente

```
npm install
npm run dev
```

Copiar `.env.example` pra `.env` e preencher com a URL e a anon key do
projeto Supabase novo.

## Uma loja Shopify

Diferente do Mental Jackpot (duas lojas), aqui é uma loja só. Os secrets
são sem sufixo:

```
npx supabase secrets set SHOPIFY_STORE_DOMAIN=sualoja.myshopify.com --project-ref <ref>
npx supabase secrets set SHOPIFY_CLIENT_ID=<Client ID do app> --project-ref <ref>
npx supabase secrets set SHOPIFY_CLIENT_SECRET=<Client Secret do app> --project-ref <ref>
npx supabase secrets set ADMIN_IMPORT_SECRET=<string longa e aleatória> --project-ref <ref>
```

## Webhook da Shopify

Código em `supabase/functions/shopify-webhook/index.ts`. Recebe
`orders/paid`, `orders/cancelled` e `refunds/create` e mantém
`sale_revenue` atualizada (upsert idempotente por `shopify_order_id` +
`shopify_line_item_id` — a Shopify pode reenviar o mesmo webhook mais de
uma vez, então não pode duplicar).

Registrar os três webhooks na loja apontando pra
`https://<seu-ref>.supabase.co/functions/v1/shopify-webhook`. A
assinatura HMAC do corpo é verificada contra `SHOPIFY_CLIENT_SECRET`.

**Forma de pagamento** (Pix vs cartão): detectada olhando se algum nome
em `payment_gateway_names` do pedido contém "pix" (case-insensitive).
Verificar com uma venda Pix real depois do primeiro deploy — se o app de
Pix da loja usar um nome diferente, ajustar o regex em
`detectPaymentMethod` (nos dois arquivos: `shopify-webhook` e
`shopify-import-orders`).

**Como o matching peça↔venda funciona:** por `shopify_product_id`, não
por SKU (a Shopify normalmente não tem SKU cadastrado em toda variante).
`product_costs.shopify_product_id` é a chave — uma linha por PEÇA, não
por variante de tamanho (P/M/G compartilham o mesmo custo de produção).

O próprio `shopify-webhook` cria a linha da peça sozinho (product_id +
nome certos, direto do payload) na primeira venda daquele produto — o
admin só precisa preencher os números de custo depois. As peças criadas
assim aparecem com o selo "custo zerado" na tela até alguém preencher.

## Importar o catálogo da Shopify

Código em `supabase/functions/shopify-import-products/index.ts`. Busca
todos os produtos da loja e cria uma linha **por peça** (não por
variante) em `product_costs`, custo zerado, com a coleção (drop) mapeada
por produto. Não sobrescreve custo já preenchido (`ignoreDuplicates`),
então roda de novo sem bagunçar nada.

```
curl -X POST https://<seu-ref>.supabase.co/functions/v1/shopify-import-products \
  -H "Authorization: Bearer <ADMIN_IMPORT_SECRET>"
```

Pra agendar rodando sozinho todo dia (opcional), copiar o padrão do
Mental Jackpot: `pg_cron` + `pg_net` chamando essa function, com o
secret guardado no Supabase Vault (não em texto puro numa migration).

## Importar pedidos históricos

Código em `supabase/functions/shopify-import-orders/index.ts`. Reusa o
mesmo `ADMIN_IMPORT_SECRET`.

```
curl -X POST https://<seu-ref>.supabase.co/functions/v1/shopify-import-orders \
  -H "Authorization: Bearer <ADMIN_IMPORT_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"since": "2026-01-01T00:00:00-03:00"}'
```

## Diferenças em relação ao Mental Jackpot

- Sem `product_line` (básico/exclusivo) — uma loja só, então não existe
  essa separação. "Coleção" (drop) continua existindo pra agrupar peça
  por lançamento.
- Uma migration só (`20260819000001_init.sql`), com o schema final já
  consolidado — em vez de replay de 17 migrations incrementais do
  projeto original.
- Todo o resto (DRE, Cupom, Pix/Cartão, Lucro por peça, Sem venda no
  período com lucro estimado) é igual.
