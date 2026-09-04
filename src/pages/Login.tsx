import { useState } from "react";
import { Navigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useSession } from "../lib/useSession";

export function Login() {
  const { session, loading: sessionLoading } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<{ kind: "idle" | "error"; message?: string }>({ kind: "idle" });
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) {
      setStatus({ kind: "error", message: "Supabase não configurado (faltam as variáveis de ambiente)." });
      return;
    }
    setBusy(true);
    setStatus({ kind: "idle" });

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setStatus({ kind: "error", message: "E-mail ou senha errados." });
    setBusy(false);
  }

  if (!sessionLoading && session) return <Navigate to="/" replace />;

  return (
    <div className="app" style={{ maxWidth: 380, paddingTop: 96 }}>
      <div className="brand" style={{ marginBottom: 28 }}>
        <img src="/logo-m.png" alt="Shadow of the Fallen" className="brand-logo" />
        <span className="brand-mark">Shadow of the Fallen</span>
        <span className="brand-sep">/</span>
        <span className="brand-app">jackpot</span>
      </div>

      <div className="panel">
        <div className="panel-head" style={{ borderBottom: "none", paddingBottom: 0 }}>
          <div>
            <div className="panel-title">Entrar</div>
            <div className="panel-hint">Acesso restrito ao admin. Contas são criadas pelo administrador.</div>
          </div>
        </div>
        <form onSubmit={handleSubmit} className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="field">
            <label>E-mail</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ textAlign: "left" }}
              autoComplete="email"
            />
          </div>
          <div className="field">
            <label>Senha</label>
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ textAlign: "left" }}
              autoComplete="current-password"
            />
          </div>

          {status.kind === "error" && (
            <div style={{ fontSize: 12, color: "var(--negative)" }}>{status.message}</div>
          )}

          <button className="btn btn-primary" type="submit" disabled={busy} style={{ marginTop: 4 }}>
            {busy ? "..." : "Entrar"}
          </button>
        </form>
      </div>
    </div>
  );
}
