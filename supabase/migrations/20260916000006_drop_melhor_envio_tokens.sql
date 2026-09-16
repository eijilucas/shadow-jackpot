-- ----------------------------------------------------------------------------
-- Remove melhor_envio_tokens — era pro fluxo OAuth (troca de `code` por
-- access_token/refresh_token), abandonado em favor de um token de
-- aplicação de longa duração (1 ano, gerado direto no painel do Melhor
-- Envio) guardado só como secret da function, nunca no banco.
-- melhor_envio_shipments continua — é a tabela de conferência manual.
-- ----------------------------------------------------------------------------
drop table if exists melhor_envio_tokens;
