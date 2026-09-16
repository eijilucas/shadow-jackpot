// Recebe os webhooks do Melhor Envio (Integrações → Área do Desenvolvedor →
// seu app → Novo Webhook) e guarda cada etiqueta em melhor_envio_shipments
// pra conferência manual depois — o Melhor Envio não tem campo de
// referência externa, então não dá pra saber sozinho qual pedido Shopify é
// cada etiqueta. O admin confirma na tela (CEP/nome/data batendo), e só aí
// o custo vai pra order_shipping.cost.
//
// O payload do webhook (`order.*`) não traz preço — só status/protocolo.
// Por isso, ao receber o evento, esta function chama de volta a API do
// Melhor Envio (GET /api/v2/me/orders/{id}) pra buscar o `price` real,
// usando o token OAuth guardado em melhor_envio_tokens (renovado sozinho
// aqui se estiver vencido).
//
// Configuração — precisa ter rodado o fluxo do melhor-envio-oauth-callback
// pelo menos uma vez antes (senão não tem token pra usar):
//   npx supabase secrets set MELHORENVIO_CLIENT_ID=<id> --project-ref <ref>
//   npx supabase secrets set MELHORENVIO_CLIENT_SECRET=<secret> --project-ref <ref>
//   npx supabase secrets set MELHORENVIO_ENV=sandbox|production --project-ref <ref>
//   npx supabase secrets set MELHORENVIO_WEBHOOK_SECRET=<secret do app no painel> --project-ref <ref>
//
// Deploy — o --no-verify-jwt é obrigatório: o header aqui é o X-ME-Signature
// do Melhor Envio, não um JWT do Supabase.
//   npx supabase functions deploy melhor-envio-webhook --no-verify-jwt --project-ref <ref>
//
// Cadastrar a URL desta function como webhook no painel do Melhor Envio
// (Integrações → Área do Desenvolvedor → seu app → Novo Webhook):
//   https://<ref>.supabase.co/functions/v1/melhor-envio-webhook

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("MELHORENVIO_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("MELHORENVIO_CLIENT_SECRET") ?? "";
const WEBHOOK_SECRET = Deno.env.get("MELHORENVIO_WEBHOOK_SECRET") ?? "";
const ENV = Deno.env.get("MELHORENVIO_ENV") ?? "sandbox";
const BASE_URL = ENV === "production" ? "https://melhorenvio.com.br" : "https://sandbox.melhorenvio.com.br";

// Eventos em que a etiqueta já tem preço fechado — não vale a pena reagir
// a todo status (created/pending ainda não geraram custo de verdade).
const RELEVANT_EVENTS = new Set(["order.generated", "order.posted", "order.delivered"]);

async function hmacBase64(rawBody: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface TokenRow {
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

// Busca o token salvo e renova se estiver a menos de 1 dia de expirar —
// evita bater o token vencido no meio de uma requisição.
async function getValidAccessToken(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase.from("melhor_envio_tokens").select("access_token, refresh_token, expires_at").eq("id", 1).maybeSingle<TokenRow>();
  if (error) throw error;
  if (!data) return null;

  const expiresInMs = new Date(data.expires_at).getTime() - Date.now();
  if (expiresInMs > 24 * 60 * 60 * 1000) return data.access_token;

  // Perto de vencer (ou já vencido) — renova com o refresh_token.
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: data.refresh_token,
    }),
  });
  if (!res.ok) {
    console.error("melhor-envio-webhook: falha ao renovar token:", res.status, await res.text());
    // Token antigo pode ainda funcionar por um tempo — tenta com ele em vez
    // de falhar tudo.
    return data.access_token;
  }
  const fresh = await res.json();
  const expiresAt = new Date(Date.now() + (fresh.expires_in ?? 30 * 24 * 60 * 60) * 1000).toISOString();
  await supabase.from("melhor_envio_tokens").update({
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token ?? data.refresh_token,
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  }).eq("id", 1);
  return fresh.access_token;
}

interface MeOrderDetail {
  id: string;
  protocol?: string;
  price?: number;
  tracking?: string;
  to?: { name?: string; address?: { zipcode?: string } | string; zipcode?: string };
}

async function fetchOrderDetail(accessToken: string, id: string): Promise<MeOrderDetail | null> {
  const res = await fetch(`${BASE_URL}/api/v2/me/orders/${id}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": "Shadow Jackpot (lucas@hinfros.com.br)",
    },
  });
  if (!res.ok) {
    console.error("melhor-envio-webhook: falha ao buscar detalhe da etiqueta:", id, res.status, await res.text());
    return null;
  }
  return await res.json();
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Método não permitido", { status: 405 });

  const rawBody = await req.text();
  const signature = req.headers.get("X-ME-Signature") ?? "";
  if (!WEBHOOK_SECRET || !signature || !timingSafeEqual(await hmacBase64(rawBody, WEBHOOK_SECRET), signature)) {
    return new Response("Assinatura inválida", { status: 401 });
  }

  let payload: { event?: string; data?: { id?: string; protocol?: string; status?: string; tracking?: string } };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("JSON inválido", { status: 400 });
  }

  const event = payload.event ?? "";
  const shipmentId = payload.data?.id;
  if (!shipmentId) return new Response("ok (sem id)", { status: 200 });
  if (!RELEVANT_EVENTS.has(event)) return new Response("ok (evento ignorado)", { status: 200 });

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const accessToken = await getValidAccessToken(supabase);
    if (!accessToken) {
      console.error("melhor-envio-webhook: sem token salvo — rode o fluxo de autorização primeiro.");
      return new Response("Não autorizado ainda com o Melhor Envio", { status: 503 });
    }

    const detail = await fetchOrderDetail(accessToken, shipmentId);
    const zipcode = typeof detail?.to?.address === "object" ? detail?.to?.address?.zipcode : detail?.to?.zipcode;

    const { error } = await supabase.from("melhor_envio_shipments").upsert(
      {
        melhor_envio_id: shipmentId,
        protocol: detail?.protocol ?? payload.data?.protocol ?? null,
        status: payload.data?.status ?? event,
        price: detail?.price ?? null,
        recipient_name: detail?.to?.name ?? null,
        recipient_zipcode: zipcode ?? null,
        tracking_code: detail?.tracking ?? payload.data?.tracking ?? null,
        event_received_at: new Date().toISOString(),
      },
      { onConflict: "melhor_envio_id" },
    );
    if (error) throw error;
  } catch (error) {
    console.error("melhor-envio-webhook:", error);
    return new Response("Erro ao processar webhook", { status: 500 });
  }

  return new Response("ok", { status: 200 });
});
