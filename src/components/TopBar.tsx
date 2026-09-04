import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export function TopBar({ subtitle, children }: { subtitle: string; children?: ReactNode }) {
  return (
    <div className="topbar">
      <div className="brand">
        <img src="/logo-m.png" alt="Shadow of the Fallen" className="brand-logo" />
        <span className="brand-mark">Shadow of the Fallen</span>
        <span className="brand-sep">/</span>
        <span className="brand-app">{subtitle}</span>
      </div>
      {children}
    </div>
  );
}

export function AdminBackLink() {
  return (
    <Link className="back-link" to="/">
      ← voltar ao dashboard
    </Link>
  );
}

export function AdminLink() {
  return (
    <Link className="icon-btn" to="/admin" title="Administração">
      ⚙
    </Link>
  );
}
