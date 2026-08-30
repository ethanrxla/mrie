import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

export function PageScaffold({
  eyebrow,
  title,
  description,
  icon: Icon,
  actions,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  icon: LucideIcon;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="workspace-page">
      <header className="workspace-header">
        <div className="workspace-header__copy">
          <div className="breadcrumbs"><span>Command center</span><ChevronRight size={12} /><strong>{eyebrow}</strong></div>
          <div className="workspace-title">
            <span className="workspace-title__icon"><Icon size={22} /></span>
            <div>
              <h1>{title}</h1>
              <p>{description}</p>
            </div>
          </div>
        </div>
        {actions && <div className="workspace-header__actions">{actions}</div>}
      </header>
      <div className="workspace-content">{children}</div>
    </div>
  );
}

export function MetricCard({ label, value, detail, trend }: { label: string; value: string; detail: string; trend?: string }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{trend && <em>{trend}</em>} {detail}</small>
    </article>
  );
}
