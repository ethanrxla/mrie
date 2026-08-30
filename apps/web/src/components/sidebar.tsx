"use client";

import {
  Bot,
  BrainCircuit,
  CalendarDays,
  ChevronsLeft,
  ChevronsRight,
  CircleUserRound,
  FolderClock,
  Gauge,
  LayoutGrid,
  Link2,
  MemoryStick,
  MessageSquareText,
  Newspaper,
  Plus,
  Settings,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { cn } from "@/components/ui/cn";
import { XynPrizeLogo } from "@/components/xynprize-logo";

const primaryNav = [
  { href: "/", label: "Command", icon: LayoutGrid },
  { href: "/conversations", label: "Conversations", icon: MessageSquareText },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/automations", label: "Automations", icon: Workflow },
  { href: "/scheduling", label: "Scheduling", icon: CalendarDays },
];

const intelligenceNav = [
  { href: "/security", label: "Security", icon: ShieldCheck },
  { href: "/briefings", label: "Briefings", icon: Newspaper },
  { href: "/memory", label: "Memory", icon: MemoryStick },
  { href: "/knowledge", label: "Knowledge", icon: BrainCircuit },
  { href: "/integrations", label: "Integrations", icon: Link2 },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const pathname = usePathname();
  const [operator, setOperator] = useState<{ name: string; company?: string } | null>(null);
  const [system, setSystem] = useState({ online: false, label: "Checking systems", detail: "Secure status channel" });

  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    void Promise.all([
      fetch("/api/profile", options).then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as { user?: { preferredName?: string; displayName?: string; company?: string } };
        if (payload.user) setOperator({ name: payload.user.preferredName || payload.user.displayName || "Account", company: payload.user.company });
      }),
      fetch("/api/status", options).then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as { status?: string; services?: Record<string, string> };
        const online = payload.status === "operational";
        setSystem({
          online,
          label: online ? "Core operational" : "Core degraded",
          detail: `${Object.keys(payload.services ?? {}).length} service states reported`,
        });
      }),
    ]).catch(() => setSystem({ online: false, label: "Status unavailable", detail: "Open Settings to inspect" }));
    return () => controller.abort();
  }, []);

  return (
    <aside className={cn("sidebar", collapsed && "sidebar--collapsed")} aria-label="Primary navigation">
      <div className="sidebar__top">
        <Link href="/" aria-label="MRE command center by XynPrize">
          <XynPrizeLogo compact={collapsed} />
        </Link>
        <button className="icon-button sidebar__collapse" type="button" onClick={onToggle} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
          {collapsed ? <ChevronsRight size={17} /> : <ChevronsLeft size={17} />}
        </button>
      </div>

      <Link
        className={cn("new-conversation", collapsed && "new-conversation--compact")}
        href="/?new=true"
        onClick={() => window.dispatchEvent(new Event("mre:new-conversation"))}
      >
        <Plus size={17} />
        {!collapsed && <span>New conversation</span>}
      </Link>

      <nav className="sidebar__nav">
        <NavGroup items={primaryNav} pathname={pathname} collapsed={collapsed} label="Workspace" />
        <NavGroup items={intelligenceNav} pathname={pathname} collapsed={collapsed} label="Intelligence" />
      </nav>

      <div className="sidebar__footer">
        <div className="system-mini" title={system.label}>
          <span className={cn("status-orb", system.online && "status-orb--online")} aria-hidden="true" />
          {!collapsed && (
            <span>
              <strong>{system.label}</strong>
              <small>{system.detail}</small>
            </span>
          )}
          {!collapsed && <Gauge size={16} aria-hidden="true" />}
        </div>
        <Link className="profile-chip" href="/settings" aria-label="Open user profile">
          <CircleUserRound size={25} aria-hidden="true" />
          {!collapsed && (
            <span>
              <strong>{operator?.name ?? "Account"}</strong>
              <small>{operator?.company || "Authenticated workspace"}</small>
            </span>
          )}
          {!collapsed && <FolderClock size={15} aria-hidden="true" />}
        </Link>
      </div>
    </aside>
  );
}

function NavGroup({
  items,
  pathname,
  collapsed,
  label,
}: {
  items: typeof primaryNav;
  pathname: string;
  collapsed: boolean;
  label: string;
}) {
  return (
    <div className="nav-group">
      {!collapsed && <p className="nav-group__label">{label}</p>}
      {items.map(({ href, label: itemLabel, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            className={cn("nav-link", active && "nav-link--active")}
            href={href}
            aria-current={active ? "page" : undefined}
            title={collapsed ? itemLabel : undefined}
          >
            <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
            {!collapsed && <span>{itemLabel}</span>}
          </Link>
        );
      })}
    </div>
  );
}
