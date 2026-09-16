// Recebe o `code` de autorização depois que o admin aprova o acesso do app
// no painel do Melhor Envio, troca por access_token/refresh_token e guarda
// em melhor_envio_tokens (única linha, id=1).
//
// Fluxo completo (uma vez só, manual):
//   1. Cadastrar o app em Integrações → Área do Desenvolvedor no painel do
//      Melhor Envio, com "URL de redirecionamento" apontando pra cá:
//      https://<ref>.supabase.co/functions/v1/melhor-envio-oauth-callback
//   2. Configurar os secrets:
//        npx supabase secrets set MELHORENVIO_CLIENT_ID=<id> --project-ref <ref>
//        npx supabase secrets set MELHORENVIO_CLIENT_SECRET=<secret> --project-ref <ref>
//        npx supabase secrets set MELHORENVIO_ENV=sandbox|production --project-ref <ref>
//   3. Deploy (precisa de --no-verify-jwt: quem chama é o navegador do
//      admin sendo redirecionado pelo Melhor Envio, não um JWT do Supabase):
//        npx supabase functions deploy melhor-envio-oauth-callback --no-verify-jwt --project-ref <ref>
//   4. Abrir a URL de autorização (troque CLIENT_ID e REDIRECT_URI):
//        https://[sandbox.]melhorenvio.com.br/oauth/authorize?client_id=<id>&redirect_uri=<url-desta-function>&response_type=code&scope=shipping-tracking%20orders-read%20purchases-read%20transactions-read
//      Aprovar → o Melhor Envio redireciona pra cá com ?code=... → esta
//      function troca o code pelo token e guarda no banco. A partir daí o
//      webhook (melhor-envio-webhook) usa e renova esse token sozinho.
//
// Endpoint de troca de token NÃO está documentado explicitamente pela API
// do Melhor Envio — segue a convenção padrão OAuth2 deles (Laravel
// Passport, {base}/oauth/token). Se der erro aqui, confere a resposta no
// log da function (ela loga o corpo cru em caso de falha) e ajusta a URL
// conforme o suporte/documentação apontar.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("MELHORENVIO_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("MELHORENVIO_CLIENT_SECRET") ?? "";
const ENV = Deno.env.get("MELHORENVIO_ENV") ?? "sandbox";

const BASE_URL = ENV === "production" ? "https://melhorenvio.com.br" : "https://sandbox.melhorenvio.com.br";

function redirectUri(req: Request): string {
  // Precisa bater exatamente com o que foi cadastrado no painel do Melhor
  // Envio, sem query string — usa a própria URL desta function.
  const url = new URL(req.url);
  return `${url.origin}${url.pathname}`;
}

function html(body: string, status = 200): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px">${body}</body>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    return html(`<h1>Autorização recusada</h1><p>${errorParam}</p>`, 400);
  }
  if (!code) {
    return html("<h1>Faltou o parâmetro code</h1><p>Acesse pela URL de autorização do Melhor Envio, não direto.</p>", 400);
  }
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return html("<h1>Não configurado</h1><p>Faltam os secrets MELHORENVIO_CLIENT_ID / MELHORENVIO_CLIENT_SECRET.</p>", 500);
  }

  const tokenRes = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: redirectUri(req),
      code,
    }),
  });

  const rawBody = await tokenRes.text();
  if (!tokenRes.ok) {
    console.error("melhor-envio-oauth-callback: token exchange falhou:", tokenRes.status, rawBody);
    return html(
      `<h1>Erro ao trocar o code pelo token (${tokenRes.status})</h1><pre>${rawBody.replace(/</g, "&lt;")}</pre>` +
        `<p>Confere o log da function pra depurar — o endpoint de troca de token não é documentado publicamente pela API do Melhor Envio.</p>`,
      502,
    );
  }

  let data: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    data = JSON.parse(rawBody);
  } catch {
    return html(`<h1>Resposta inesperada</h1><pre>${rawBody.replace(/</g, "&lt;")}</pre>`, 502);
  }
  if (!data.access_token || !data.refresh_token) {
    return html(`<h1>Resposta sem os tokens esperados</h1><pre>${rawBody.replace(/</g, "&lt;")}</pre>`, 502);
  }

  const expiresAt = new Date(Date.now() + (data.expires_in ?? 30 * 24 * 60 * 60) * 1000).toISOString();
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { error } = await supabase
    .from("melhor_envio_tokens")
    .upsert({ id: 1, access_token: data.access_token, refresh_token: data.refresh_token, expires_at: expiresAt, updated_at: new Date().toISOString() });

  if (error) {
    console.error("melhor-envio-oauth-callback: falha ao salvar token:", error);
    return html(`<h1>Token obtido, mas falhou ao salvar</h1><pre>${JSON.stringify(error)}</pre>`, 500);
  }

  return html("<h1>Conectado ✓</h1><p>Pode fechar essa aba. O Jackpot já está autorizado a consultar o custo das etiquetas.</p>");
});
