import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useSession } from "../lib/useSession";
import { supabase } from "../lib/supabase";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useSession();

  if (!supabase) return <>{children}</>; // sem env configurada ainda: deixa passar, roda com dado mockado
  if (loading) return null;
  if (!session) return <Navigate to="/login" replace />;

  return <>{children}</>;
}

export function SignOutButton() {
  if (!supabase) return null;
  const client = supabase;
  return (
    <button className="icon-btn" title="Sair" onClick={() => client.auth.signOut()}>
      ⏻
    </button>
  );
}
