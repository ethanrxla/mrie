"use client";

import {
  CalendarDays,
  Check,
  Database,
  Github,
  Globe2,
  Link2,
  Mail,
  MessageCircle,
  Network,
  Plus,
  Search,
  ShieldCheck,
  Unplug,
  Video,
  Youtube,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { PageScaffold } from "@/components/pages/page-scaffold";
import { ConfirmDialog, type ConfirmationRequest } from "@/components/ui/confirm-dialog";

const integrations = [
  { id: "google-calendar", name: "Google Calendar", description: "Availability, appointments, and scheduling workflows.", category: "Productivity", icon: CalendarDays, color: "blue" },
  { id: "google-drive", name: "Google Drive", description: "Trusted documents and business knowledge sources.", category: "Knowledge", icon: Database, color: "cyan" },
  { id: "gmail", name: "Gmail", description: "Approval-gated drafting and outbound communication.", category: "Communication", icon: Mail, color: "magenta" },
  { id: "youtube", name: "YouTube", description: "Supported subscription and channel intelligence feeds.", category: "Intelligence", icon: Youtube, color: "magenta" },
  { id: "instagram", name: "Instagram", description: "Official API insights for authorized business accounts.", category: "Intelligence", icon: Globe2, color: "violet" },
  { id: "github", name: "GitHub", description: "Repository activity, issues, and operational delivery signals.", category: "Operations", icon: Github, color: "violet" },
  { id: "tailscale", name: "Tailscale", description: "Policy-controlled device inventory and network access.", category: "Infrastructure", icon: Network, color: "cyan" },
  { id: "meet", name: "Google Meet", description: "Join links and appointment conference details.", category: "Productivity", icon: Video, color: "blue" },
  { id: "slack", name: "Slack", description: "Approval-gated team notifications and workflow events.", category: "Communication", icon: MessageCircle, color: "violet" },
];

export function IntegrationsView() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [states, setStates] = useState<Record<string, boolean>>(Object.fromEntries(integrations.map((integration) => [integration.id, false])));
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const filtered = useMemo(() => integrations.filter((integration) =>
    (category === "All" || integration.category === category) &&
    `${integration.name} ${integration.description} ${integration.category}`.toLowerCase().includes(query.toLowerCase()),
  ), [category, query]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/preferences", { signal: controller.signal }).then(async (response) => {
      if (!response.ok) return;
      const payload = (await response.json()) as { preferences?: Record<string, unknown> };
      const selected = payload.preferences?.["integrations.selected"];
      if (Array.isArray(selected)) {
        const enabled = new Set(selected.filter((item): item is string => typeof item === "string"));
        setStates(Object.fromEntries(integrations.map((integration) => [integration.id, enabled.has(integration.id)])));
      }
    }).catch(() => undefined);
    return () => controller.abort();
  }, []);

  const requestChange = (integration: (typeof integrations)[number]) => {
    const connected = states[integration.id];
    setConfirmation({
      title: `${connected ? "Disconnect" : "Connect"} ${integration.name}?`,
      description: connected
        ? `MRE will immediately stop using ${integration.name}. Existing conversation records and explicitly saved memory are not deleted by disconnecting.`
        : `This enables ${integration.name} in your workspace policy. Live access begins only after its server-side adapter has been authorized; XynPrize never asks you to paste access tokens into the browser.`,
      confirmLabel: connected ? "Disable" : "Enable connector",
      tone: connected ? "danger" : "default",
      onConfirm: async () => {
        const next = { ...states, [integration.id]: !connected };
        const response = await fetch("/api/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: "integrations.selected", value: Object.entries(next).filter(([, enabled]) => enabled).map(([id]) => id) }),
        }).catch(() => null);
        if (!response?.ok) {
          setNotice(`${integration.name} could not be updated.`);
          return;
        }
        setStates(next);
        setNotice(`${integration.name} ${connected ? "disabled" : "enabled"} for this workspace. A server-side connector must be configured before live access is available.`);
      },
    });
  };

  return (
    <PageScaffold eyebrow="Integrations" title="Connected systems" description="Choose which server-side connectors MRE may use. Enabling a card never exposes credentials in the browser." icon={Link2} actions={<Link className="button button--primary" href="/?new=true"><Plus size={16} /> Request integration</Link>}>
      {notice && <div className="inline-notice"><Check size={15} /><span>{notice}</span><button type="button" onClick={() => setNotice(null)}>Dismiss</button></div>}
      <div className="integration-summary"><div><span className="integration-summary__icon"><Link2 size={20} /></span><div><strong>{Object.values(states).filter(Boolean).length} systems enabled</strong><p>Provider authorization and credentials stay in server-side adapters and can be revoked at any time.</p></div></div><span><ShieldCheck size={14} /> Least-privilege access</span></div>
      <div className="filter-bar"><label className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search integrations" aria-label="Search integrations" /></label><label className="select-wrap"><span className="sr-only">Integration category</span><select value={category} onChange={(event) => setCategory(event.target.value)}><option>All</option>{[...new Set(integrations.map((item) => item.category))].map((item) => <option key={item}>{item}</option>)}</select></label></div>
      <div className="integration-grid">
        {filtered.map((integration) => {
          const Icon = integration.icon;
          const connected = states[integration.id];
          return <article key={integration.id} className={`integration-card integration-card--${integration.color}`}><header><span><Icon size={21} /></span></header><h2>{integration.name}</h2><span className="integration-category">{integration.category}</span><p>{integration.description}</p><footer><span className={connected ? "connection-state connection-state--connected" : "connection-state"}>{connected ? <><Check size={12} /> Enabled</> : <><Unplug size={12} /> Disabled</>}</span><button className={connected ? "button button--secondary" : "button button--primary"} type="button" onClick={() => requestChange(integration)}>{connected ? "Manage" : "Enable"}</button></footer></article>;
        })}
      </div>
      <ConfirmDialog request={confirmation} onClose={() => setConfirmation(null)} />
    </PageScaffold>
  );
}
