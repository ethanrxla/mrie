"use client";

import {
  Accessibility,
  Bell,
  Check,
  ChevronDown,
  CircleUserRound,
  KeyRound,
  MemoryStick,
  Mic,
  Save,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Volume2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { PageScaffold } from "@/components/pages/page-scaffold";
import { cn } from "@/components/ui/cn";

type SettingsTab = "profile" | "voice" | "intelligence" | "accessibility" | "security";

interface Profile {
  displayName: string;
  preferredName: string;
  company: string;
  roleTitle: string;
  timezone: string;
}

const defaultProfile: Profile = { displayName: "", preferredName: "", company: "", roleTitle: "", timezone: "UTC" };

export function SettingsView() {
  const router = useRouter();
  const [tab, setTab] = useState<SettingsTab>("profile");
  const [profile, setProfile] = useState(defaultProfile);
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<Record<string, unknown>>({
    "memory.autoSave": true,
    "voice.spokenResponses": true,
    "voice.handsFree": false,
    "voice.speed": 1,
    "sound.effects": true,
    "sound.volume": 0.7,
    "accessibility.highContrast": false,
    "accessibility.reducedMotion": false,
    "response.style": "concise",
  });

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/profile", { signal: controller.signal }).then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as { user?: Partial<Profile> };
        if (payload.user) setProfile((current) => ({ ...current, ...payload.user }));
      }),
      fetch("/api/preferences", { signal: controller.signal }).then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as { preferences?: Record<string, unknown> };
        if (payload.preferences) setPreferences((current) => ({ ...current, ...payload.preferences }));
      }),
    ]).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setNotice("Profile or preference data could not be loaded. No placeholder profile is being shown.");
      }
    });
    return () => controller.abort();
  }, []);

  const updatePreference = async (key: string, value: unknown) => {
    const previous = preferences[key];
    setPreferences((current) => ({ ...current, [key]: value }));
    window.dispatchEvent(new CustomEvent("mre:preference", { detail: { key, value } }));
    const response = await fetch("/api/preferences", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, value }) }).catch(() => null);
    if (!response?.ok) {
      setPreferences((current) => ({ ...current, [key]: previous }));
      window.dispatchEvent(new CustomEvent("mre:preference", { detail: { key, value: previous } }));
      setNotice("That preference could not be saved. Your prior setting was restored.");
    }
  };

  const saveProfile = async () => {
    const response = await fetch("/api/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profile) }).catch(() => null);
    setSaved(Boolean(response?.ok));
    if (!response?.ok) setNotice("Profile changes could not be saved.");
    window.setTimeout(() => setSaved(false), 1800);
  };

  const signOut = async () => {
    const response = await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    if (response?.ok) router.replace("/login");
  };

  const tabs: Array<{ id: SettingsTab; label: string; icon: typeof Settings }> = [
    { id: "profile", label: "Profile", icon: CircleUserRound },
    { id: "voice", label: "Voice & sound", icon: Volume2 },
    { id: "intelligence", label: "Intelligence", icon: Sparkles },
    { id: "accessibility", label: "Accessibility", icon: Accessibility },
    { id: "security", label: "Security", icon: ShieldCheck },
  ];

  return (
    <PageScaffold eyebrow="Settings" title="Command preferences" description="Shape how MRE addresses you, speaks, remembers, and renders this workspace." icon={Settings} actions={<Link className="button button--secondary" href="/onboarding"><SlidersHorizontal size={15} /> Run setup again</Link>}>
      {notice && <div className="inline-notice inline-notice--warning" role="status"><ShieldCheck size={15} /><span>{notice}</span><button type="button" onClick={() => setNotice(null)}>Dismiss</button></div>}
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">{tabs.map(({ id, label, icon: Icon }) => <button key={id} type="button" className={cn(tab === id && "is-active")} onClick={() => setTab(id)} aria-current={tab === id ? "page" : undefined}><Icon size={16} /> {label}</button>)}</nav>
        <section className="settings-panel">
          {tab === "profile" && <><SettingsHeading title="Your profile" description="MRE uses this context to address you appropriately and schedule in the correct time zone." icon={CircleUserRound} /><div className="settings-form"><div className="form-row"><Field label="Display name"><input value={profile.displayName} onChange={(event) => setProfile({ ...profile, displayName: event.target.value })} /></Field><Field label="How MRE should address you"><input value={profile.preferredName} onChange={(event) => setProfile({ ...profile, preferredName: event.target.value })} /></Field></div><div className="form-row"><Field label="Company"><input value={profile.company} onChange={(event) => setProfile({ ...profile, company: event.target.value })} /></Field><Field label="Role"><input value={profile.roleTitle} onChange={(event) => setProfile({ ...profile, roleTitle: event.target.value })} /></Field></div><Field label="Time zone"><div className="select-wrap"><select value={profile.timezone} onChange={(event) => setProfile({ ...profile, timezone: event.target.value })}><option value="America/New_York">Eastern Time · America/New_York</option><option value="America/Chicago">Central Time · America/Chicago</option><option value="America/Denver">Mountain Time · America/Denver</option><option value="America/Los_Angeles">Pacific Time · America/Los_Angeles</option><option value="Europe/London">United Kingdom · Europe/London</option><option value="UTC">UTC</option></select><ChevronDown size={14} /></div></Field><div className="settings-actions"><button className="button button--primary" type="button" onClick={() => void saveProfile()}>{saved ? <Check size={15} /> : <Save size={15} />}{saved ? "Saved" : "Save profile"}</button></div></div></>}
          {tab === "voice" && <><SettingsHeading title="Voice & sound" description="Choose when MRE speaks and how voice interactions should feel." icon={Volume2} /><SettingToggle title="Spoken responses" description="Read new assistant responses aloud. Captions remain visible." checked={Boolean(preferences["voice.spokenResponses"])} onChange={(value) => void updatePreference("voice.spokenResponses", value)} icon={Volume2} /><SettingToggle title="Hands-free by default" description="Start new sessions in opt-in continuous conversation mode." checked={Boolean(preferences["voice.handsFree"])} onChange={(value) => void updatePreference("voice.handsFree", value)} icon={Mic} /><SettingToggle title="Interface sounds" description="Play restrained original activation, completion, and warning tones." checked={Boolean(preferences["sound.effects"])} onChange={(value) => void updatePreference("sound.effects", value)} icon={Bell} /><div className="range-setting"><div><strong>Master volume</strong><p>Controls speech and interface sound output.</p></div><input type="range" min="0" max="1" step="0.05" value={Number(preferences["sound.volume"])} onChange={(event) => void updatePreference("sound.volume", Number(event.target.value))} /><em>{Math.round(Number(preferences["sound.volume"]) * 100)}%</em></div><div className="range-setting"><div><strong>Voice speed</strong><p>Playback speed for spoken responses.</p></div><input type="range" min="0.7" max="1.4" step="0.1" value={Number(preferences["voice.speed"])} onChange={(event) => void updatePreference("voice.speed", Number(event.target.value))} /><em>{Number(preferences["voice.speed"]).toFixed(1)}×</em></div></>}
          {tab === "intelligence" && <><SettingsHeading title="Intelligence behavior" description="Control what MRE retains and how it presents its work." icon={Sparkles} /><SettingToggle title="Automatic memory" description="Let MRE propose and store useful non-sensitive long-term context." checked={Boolean(preferences["memory.autoSave"])} onChange={(value) => void updatePreference("memory.autoSave", value)} icon={MemoryStick} /><div className="setting-row"><span className="setting-row__icon"><SlidersHorizontal size={17} /></span><div><strong>Preferred response style</strong><p>Choose the default level of detail for routine answers.</p></div><div className="select-wrap"><select value={String(preferences["response.style"])} onChange={(event) => void updatePreference("response.style", event.target.value)}><option value="concise">Concise</option><option value="balanced">Balanced</option><option value="detailed">Detailed</option></select><ChevronDown size={14} /></div></div><Link className="settings-deep-link" href="/memory">Open memory control center <MemoryStick size={15} /></Link></>}
          {tab === "accessibility" && <><SettingsHeading title="Accessibility" description="Keep every command, status, and response perceivable and operable." icon={Accessibility} /><SettingToggle title="Reduced motion" description="Minimize core rotation, particles, scanning, and panel transitions." checked={Boolean(preferences["accessibility.reducedMotion"])} onChange={(value) => void updatePreference("accessibility.reducedMotion", value)} icon={Accessibility} /><SettingToggle title="High contrast" description="Increase panel, border, control, and text contrast." checked={Boolean(preferences["accessibility.highContrast"])} onChange={(value) => void updatePreference("accessibility.highContrast", value)} icon={SlidersHorizontal} /><div className="policy-banner"><Check size={15} /><span>Captions and keyboard navigation are always enabled, independent of these preferences.</span></div></>}
          {tab === "security" && <><SettingsHeading title="Security & sessions" description="Review authenticated access and the controls around consequential actions." icon={ShieldCheck} /><div className="security-setting"><span><KeyRound size={18} /></span><div><strong>Authenticated session</strong><p>End this browser session and return to secure sign-in.</p></div><button className="button button--secondary" type="button" onClick={() => void signOut()}>Sign out</button></div><div className="security-setting"><span><ShieldCheck size={18} /></span><div><strong>Approval protection</strong><p>External messages, appointments, deletion, publishing, lead contact, and paid services require confirmation.</p></div><em>Always on</em></div><div className="security-setting"><span><SlidersHorizontal size={18} /></span><div><strong>Structured activity log</strong><p>Review approval-gated automation and agent activity.</p></div><Link className="button button--secondary" href="/automations">View activity</Link></div></>}
        </section>
      </div>
    </PageScaffold>
  );
}

function SettingsHeading({ title, description, icon: Icon }: { title: string; description: string; icon: typeof Settings }) { return <header className="settings-heading"><span><Icon size={20} /></span><div><h2>{title}</h2><p>{description}</p></div></header>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field-label"><span>{label}</span>{children}</label>; }
function SettingToggle({ title, description, checked, onChange, icon: Icon }: { title: string; description: string; checked: boolean; onChange: (checked: boolean) => void; icon: typeof Settings }) { return <div className="setting-row"><span className="setting-row__icon"><Icon size={17} /></span><div><strong>{title}</strong><p>{description}</p></div><label className="switch-control"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span aria-hidden="true" /><em>{checked ? "On" : "Off"}</em></label></div>; }
