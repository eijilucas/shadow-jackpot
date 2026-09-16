// Importa o catálogo de produto da Shopify pra `product_costs`, criando
// as linhas que ainda não existem (uma por PEÇA, não por variante — P/M/G
// da mesma peça compartilham o mesmo custo de tecido/estampa/costura,
// então uma linha só evita repetição e é como o admin realmente pensa o
// custo). Rodar isso deixa o admin com o catálogo pronto pra preencher
// custo, em vez de ir descobrindo peça por peça conforme vendem.
//
// Não é um webhook — é disparada manualmente ou por um cron diário (ver
// migração de schedule, se você criar uma), com um POST protegido por
// secret próprio (não usa o secret de webhook, porque isso aqui não vem
// da Shopify, é a gente chamando a function).
//
// Configuração necessária (modelo de app custom via Dev Dashboard, 2026):
// o token de acesso da Admin API expira em 24h, então a função gera um
// novo sozinha a cada execução via Client Credentials Grant, usando o
// Client ID/Secret do app (esses não expiram).
//   npx supabase secrets set SHOPIFY_STORE_DOMAIN=sualoja.myshopify.com --project-ref <ref>
//   npx supabase secrets set SHOPIFY_CLIENT_ID=<ID do app> --project-ref <ref>
//   npx supabase secrets set SHOPIFY_CLIENT_SECRET=<secret do app> --project-ref <ref>
//   npx supabase secrets set ADMIN_IMPORT_SECRET=<qualquer string longa e aleatória> --project-ref <ref>
//
// Deploy — o --no-verify-jwt é obrigatório: a auth aqui é o Bearer do
// ADMIN_IMPORT_SECRET, não um JWT do Supabase, e sem a flag o gateway
// devolve UNAUTHORIZED_INVALID_JWT_FORMAT antes da função rodar.
//   npx supabase functions deploy shopify-import-products --no-verify-jwt --project-ref <ref>
//
// Disparar a importação:
//   curl -X POST https://<ref>.supabase.co/functions/v1/shopify-import-products \
//     -H "Authorization: Bearer <ADMIN_IMPORT_SECRET>"

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const ADMIN_IMPORT_SECRET = Deno.env.get("ADMIN_IMPORT_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SHOPIFY_STORE_DOMAIN = Deno.env.get("SHOPIFY_STORE_DOMAIN") ?? "";
const SHOPIFY_CLIENT_ID = Deno.env.get("SHOPIFY_CLIENT_ID") ?? "";
const SHOPIFY_CLIENT_SECRET = Deno.env.get("SHOPIFY_CLIENT_SECRET") ?? "";

// Versão da API REST da Shopify — confira em shopify.dev se ainda é
// suportada na hora de configurar; elas saem trimestralmente.
const SHOPIFY_API_VERSION = "2025-01";

interface ShopifyVariant {
  id: number;
  sku: string | null;
}

interface ShopifyProduct {
  id: number;
  title: string;
  variants: ShopifyVariant[];
}

interface ProductCostStub {
  shopify_product_id: number;
  sku: string | null;
  product_name: string;
  collection: string | null;
  collection_published_at: string | null;
  tecido: number;
  estampa: number;
  costura: number;
  outros_acabamentos: number;
}

interface CollectionInfo {
  title: string;
  publishedAt: string | null;
}

function extractNextUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const nextPart = linkHeader.split(",").find((part) => part.includes('rel="next"'));
  if (!nextPart) return null;
  const match = nextPart.match(/<([^>]+)>/);
  return match ? match[1] : null;
}

async function fetchAccessToken(): Promise<string> {
  const res = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    throw new Error(`Shopify (${SHOPIFY_STORE_DOMAIN}) respondeu ${res.status} ao gerar token de acesso`);
  }
  const data = await res.json();
  return data.access_token as string;
}

// Mapeia produto -> coleção (drop) — puramente informativo, só pra
// separar a tela do admin por lançamento, não entra no cálculo de
// margem. collection_published_at mais recente é o "drop atual".
async function fetchCollectionTitles(accessToken: string): Promise<Map<number, CollectionInfo>> {
  const collections = new Map<number, CollectionInfo>();
  let url: string | null =
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/custom_collections.json?limit=250&fields=id,title,handle,published_at`;

  while (url) {
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": accessToken } });
    if (!res.ok) throw new Error(`Shopify (${SHOPIFY_STORE_DOMAIN}) respondeu ${res.status} ao listar coleções`);
    const data = await res.json();
    for (const c of data.custom_collections ?? []) {
      collections.set(c.id, { title: c.title, publishedAt: c.published_at ?? null });
    }
    url = extractNextUrl(res.headers.get("Link"));
  }

  return collections;
}

async function fetchProductCollectionMap(accessToken: string): Promise<Map<number, CollectionInfo>> {
  const collections = await fetchCollectionTitles(accessToken);
  const productToCollection = new Map<number, CollectionInfo>();

  let url: string | null = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/collects.json?limit=250`;
  while (url) {
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": accessToken } });
    if (!res.ok) throw new Error(`Shopify (${SHOPIFY_STORE_DOMAIN}) respondeu ${res.status} ao listar collects`);
    const data = await res.json();
    for (const collect of data.collects ?? []) {
      if (productToCollection.has(collect.product_id)) continue; // já achou uma coleção pra esse produto
      const info = collections.get(collect.collection_id);
      if (info) productToCollection.set(collect.product_id, info);
    }
    url = extractNextUrl(res.headers.get("Link"));
  }

  return productToCollection;
}

async function fetchAllProducts(accessToken: string): Promise<ShopifyProduct[]> {
  const products: ShopifyProduct[] = [];
  let url: string | null = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=250`;

  while (url) {
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": accessToken } });
    if (!res.ok) {
      throw new Error(`Shopify (${SHOPIFY_STORE_DOMAIN}) respondeu ${res.status} ao listar produtos`);
    }
    const data = await res.json();
    products.push(...(data.products ?? []));
    url = extractNextUrl(res.headers.get("Link"));
  }

  return products;
}

// Produtos que nunca são peça de roupa de verdade (não faz sentido
// rastrear custo de produção deles) — ficam de fora da importação pra
// sempre, mesmo que a Shopify tenha um novo desse tipo no futuro.
const EXCLUDED_NAME_PATTERNS = [/gift\s*card/i];

async function importProducts(supabase: SupabaseClient): Promise<number> {
  const accessToken = await fetchAccessToken();
  const products = (await fetchAllProducts(accessToken)).filter(
    (product) => !EXCLUDED_NAME_PATTERNS.some((re) => re.test(product.title)),
  );
  const productCollection = await fetchProductCollectionMap(accessToken);

  // Uma linha por PEÇA, não por variante — pega o SKU da primeira
  // variante que tiver um preenchido (se nenhuma tiver, fica null).
  const stubs: ProductCostStub[] = products.map((product) => {
    const info = productCollection.get(product.id);
    return {
      shopify_product_id: product.id,
      sku: product.variants?.find((v) => v.sku)?.sku ?? null,
      product_name: product.title,
      collection: info?.title ?? null,
      collection_published_at: info?.publishedAt ?? null,
      tecido: 0,
      estampa: 0,
      costura: 0,
      outros_acabamentos: 0,
    };
  });

  if (stubs.length === 0) return 0;

  // Uma peça pode já ter uma linha em product_costs criada pela venda (o
  // webhook ou o import de pedidos cria o stub na primeira venda, antes
  // de este import rodar). Pra essas, só sincroniza a coleção — nunca os
  // campos de custo, que o admin pode já ter preenchido na mão, e nunca
  // product_name/sku, que o admin pode ter corrigido manualmente.
  const { data: existing, error: fetchError } = await supabase
    .from("product_costs")
    .select("shopify_product_id")
    .in("shopify_product_id", stubs.map((s) => s.shopify_product_id));
  if (fetchError) throw fetchError;
  const existingIds = new Set((existing ?? []).map((r) => r.shopify_product_id as number));

  const newStubs = stubs.filter((s) => !existingIds.has(s.shopify_product_id));
  const collectionUpdates = stubs.filter((s) => existingIds.has(s.shopify_product_id));

  if (newStubs.length > 0) {
    const { error } = await supabase
      .from("product_costs")
      .upsert(newStubs, { onConflict: "shopify_product_id", ignoreDuplicates: true });
    if (error) throw error;
  }

  for (const s of collectionUpdates) {
    const { error } = await supabase
      .from("product_costs")
      .update({ collection: s.collection, collection_published_at: s.collection_published_at })
      .eq("shopify_product_id", s.shopify_product_id);
    if (error) throw error;
  }

  return stubs.length;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Método não permitido", { status: 405 });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!ADMIN_IMPORT_SECRET || !timingSafeEqual(authHeader, `Bearer ${ADMIN_IMPORT_SECRET}`)) {
    return new Response("Não autorizado", { status: 401 });
  }

  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    return new Response("Loja Shopify não configurada (faltam os secrets SHOPIFY_STORE_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET)", { status: 500 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const pecas_encontradas = await importProducts(supabase);
    return new Response(JSON.stringify({ ok: true, pecas_encontradas }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
