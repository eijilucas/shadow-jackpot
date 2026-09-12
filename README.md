# Shadow of the Fallen - Jackpot

Adaptado do projeto irmão **Mental Madness — Jackpot**, mesma arquitetura,
uma loja Shopify só. Calcula a margem real de cada venda (faturamento →
custo direto → custos da venda → marketing rateado → fixos rateados →
resultado do frete → lucro líquido).

Stack: Vite + React 19 + TypeScript + react-router-dom + @supabase/supabase-js.

## Estado atual

Este repositório é só o **código**, adaptado pra uma loja só (sem o
conceito de "linha de produto" do projeto original, que existia porque
lá tinha duas lojas Shopify diferentes). O código está em dia com todas
as correções de cálculo feitas no Mental Madness até 13/09/2026 (ver
"O que veio do Jackpot" abaixo).

Faltam os passos de infra — nenhum deles foi feito ainda:

- [ ] Criar o app customizado na loja Shopify (`Configurações → Apps →
      Desenvolver apps`), pegar Client ID/Secret.
- [ ] Criar um projeto Supabase novo (separado do Mental Jackpot).
- [ ] Rodar a migration `supabase/migrations/20260819000001_init.sql`
      nesse projeto novo (`npx supabase db push`).
- [ ] Configurar os secrets da function (ver seções abaixo).
- [ ] Deploy das quatro edge functions — `shipping-cost-callback` precisa
      de `--no-verify-jwt`.
- [ ] Registrar os webhooks na Shopify.
- [ ] Deploy do frontend (Vercel ou outro), com `.env` apontando pro
      Supabase novo.
- [ ] Trocar a logo (`public/logo-m.png`) e as URLs do `index.html`
      (`og:image`, `og:url`) pelas de verdade.
- [ ] Inserir o(s) e-mail(s) de admin em `admin_emails` (a migration
      deixou um `insert` comentado no final, só descomentar e ajustar).

> **Antes de rodar qualquer `supabase` aqui:** este diretório já esteve
> linkado, por engano, ao projeto de produção do Mental Madness. O link
> foi removido. Ao rodar `db push` ou `functions deploy`, passe sempre
> `--project-ref <ref do projeto NOVO>` — ou rode `npx supabase link`
> apontando pro projeto certo antes. Um deploy no ref errado sobrescreve
> as functions da outra loja.

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
npx supabase secrets set SHIPPING_COST_CALLBACK_SECRET=<string longa e aleatória> --project-ref <ref>
```

## Webhook da Shopify

Código em `supabase/functions/shopify-webhook/index.ts`. Recebe
`orders/paid`, `orders/cancelled` e `refunds/create` e mantém
`sale_revenue` e `order_shipping` atualizadas (upsert idempotente por
`shopify_order_id` + `shopify_line_item_id` — a Shopify pode reenviar o
mesmo webhook mais de uma vez, então não pode duplicar).

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
assim aparecem com o selo "sem custo" na aba "Lucro por peça" até alguém
preencher.

## Frete

São dois lados, e os dois vivem em `order_shipping`:

- **Cobrado** (`revenue`) — vem sozinho da Shopify pelo webhook / import.
- **Pago** (`cost`) — precisa ser empurrado pelo sistema que compra a
  etiqueta, via a edge function `shipping-cost-callback`:

```
npx supabase functions deploy shipping-cost-callback --no-verify-jwt --project-ref <ref>
```

O `--no-verify-jwt` não é opcional: a autenticação dessa function é uma
assinatura HMAC-SHA256 do corpo cru no header `X-Signature`, não um JWT
do Supabase. Sem a flag, o gateway devolve
`UNAUTHORIZED_INVALID_JWT_FORMAT` antes da função rodar.

Enquanto ninguém empurra o custo real, o pedido cai no valor estimado de
`sale_fee_rates.taxa_frete_estimado` — que nasce em **zero de propósito**:
melhor ver "sem custo real" do que um chute virando lucro. A aba **Frete**
do admin avisa quantos pedidos do período estão nessa situação.

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

## O que veio do Jackpot (correções de cálculo)

O clone original era um retrato do schema de 19/08. Depois disso o Mental
Madness passou por uma auditoria inteira da DRE, e tudo que saiu de lá
está aqui:

- **Cupom entra na conta.** `sale_revenue.discount_amount` guarda o
  desconto do item; o faturamento usado em todo lugar é
  `gross_amount - discount_amount`. Antes a receita era a tabela cheia,
  inflando faturamento e lucro.
- **Comissão de influencer só com cupom.** Antes era cobrada em toda
  venda, com ou sem cupom.
- **Frete na DRE**, os dois lados, mais o reajuste de conferência da
  transportadora (`cost_adjustment`).
- **Taxa de antifraude** por pedido no cartão (o Pix não tem — ele já
  tinha a taxa fixa dele).
- **Taxas percentuais incidem sobre produto + frete cobrado**, que é como
  o gateway cobra de verdade.
- **Rateio pró-rata no mês corrente.** Gasto fixo (e marketing herdado) é
  projeção do mês inteiro, então entra proporcional aos dias decorridos —
  senão a venda do dia 1 carrega o aluguel fechado e nasce no prejuízo.
  Valor digitado na mão entra inteiro, porque já foi gasto.
- **Marketing recorrente** (`monthly_overhead.recorrente`): tráfego pago
  se repete todo mês sozinho, como um gasto fixo. Marcável linha a linha.
- **`net_profit` é a soma das colunas já arredondadas**, não a fórmula
  reescrita por inteiro. O waterfall fecha no centavo por construção, e
  não dá mais pra corrigir a conta num lugar e esquecer do outro.
- **`has_real_shipping_cost`** na view, pra tela conseguir avisar quando o
  custo de frete é estimado e não real.
- **Peça sem custo cadastrado** ganha o selo "sem custo" no ranking de
  margem — margem de 80% quase sempre é custo faltando, não lucro.
- **Card de DRE vazio não aparece** no dashboard.

## Diferenças em relação ao Mental Jackpot

- Sem `product_line` (básico/exclusivo) — uma loja só, então não existe
  essa separação. "Coleção" (drop) continua existindo pra agrupar peça
  por lançamento.
- Sem venda externa (`source`) — lá existe um sistema separado que
  registra pedido de WhatsApp/Instagram/Discord, que nunca passa pelo
  checkout. Se um dia fizer falta aqui, o caminho é copiar a coluna
  `source`, a linha `id = 2` de `sale_fee_rates` e a function
  `register-external-sale` do projeto irmão.
- Uma migration só (`20260819000001_init.sql`), com o schema final já
  consolidado — em vez de replay das 32 migrations incrementais do
  projeto original.
- Dashboard com um waterfall só (lá são quatro, porque existe quebra por
  linha de produto e por origem da venda).
- Todo o resto (Custo de cada peça, Taxas de venda, Gastos do mês, Frete,
  Lucro por peça, Cupom, Pix/Cartão, Sem venda no período com lucro
  estimado) é igual.
