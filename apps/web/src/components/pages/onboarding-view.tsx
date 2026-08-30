"use client";

import {
  ArrowLeft,
  ArrowRight,
  Bot,
  CalendarDays,
  Check,
  Database,
  Headphones,
  Link2,
  MemoryStick,
  Mic,
  Radio,
  ShieldCheck,
  Sparkles,
  UserRound,
  Volume2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AiCore } from "@/components/command/ai-core";
import { useMicrophone } from "@/components/hooks/use-microphone";
import { useSpeechOutput } from "@/components/hooks/use-speech-output";
import { XynPrizeLogo } from "@/components/xynprize-logo";

const steps = ["Welcome", "Identity", "Voice", "Microphone", "Conversation", "Memory", "Integrations", "Voice test", "Ready"];

export function OnboardingView() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [displayName, setDisplayName] = useState("");
  const [preferredName, setPreferredName] = useState("");
  const [mode, setMode] = useState<"push" | "continuous">("push");
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [connected, setConnected] = useState<string[]>([]);
  const [testTranscript, setTestTranscript] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const speech = useSpeechOutput();
  const microphone = useMicrophone({ onFinalTranscript: setTestTranscript, onStart: speech.stop });

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/profile", { signal: controller.signal }).then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as { user?: { displayName?: string; preferredName?: string } };
        if (payload.user?.displayName) setDisplayName(payload.user.displayName);
        if (payload.user?.preferredName) setPreferredName(payload.user.preferredName);
      }),
      fetch("/api/preferences", { signal: controller.signal }).then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as { preferences?: Record<string, unknown> };
        const preferences = payload.preferences ?? {};
        if (typeof preferences["memory.autoSave"] === "boolean") setMemoryEnabled(preferences["memory.autoSave"] as boolean);
        if (typeof preferences["voice.handsFree"] === "boolean") setMode(preferences["voice.handsFree"] ? "continuous" : "push");
        if (Array.isArray(preferences["integrations.selected"])) {
          setConnected(preferences["integrations.selected"].filter((item): item is string => typeof item === "string"));
        }
      }),
    ]).catch(() => undefined);
    return () => controller.abort();
  }, []);

  const complete = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: displayName.trim() || "Operator",
          preferredName: preferredName.trim() || displayName.trim() || "Operator",
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          memoryEnabled,
          conversationMode: mode,
          spokenResponses: !speech.muted,
          voiceSpeed: speech.rate,
          browserVoice: speech.selectedVoice,
          integrations: connected,
        }),
      });
      if (!response.ok) throw new Error("Setup could not be saved");
      router.push("/");
      router.refresh();
    } catch {
      setSaveError("MRE could not save setup. Your choices remain here so you can retry.");
      setSaving(false);
    }
  };

  return (
    <div className="onboarding">
      <div className="onboarding__ambient" aria-hidden="true" />
      <header className="onboarding__header"><XynPrizeLogo /><span>Private setup · about 2 minutes</span></header>
      <div className="onboarding__progress" aria-label={`Setup step ${step + 1} of ${steps.length}`}>{steps.map((label, index) => <span key={label} className={index <= step ? "is-complete" : ""}><i>{index < step ? <Check size={10} /> : index + 1}</i><em>{label}</em></span>)}</div>

      <main className="onboarding__panel">
        <div className="onboarding__visual"><AiCore state={microphone.isListening ? "listening" : speech.speaking ? "speaking" : step === 8 ? "success" : "idle"} audioLevel={microphone.isListening ? microphone.inputLevel : speech.level} /></div>
        <section className="onboarding__content">
          {step === 0 && <OnboardSection icon={Sparkles} eyebrow="Meet MRE" title="Your central operating intelligence" description="MRE coordinates business context, conversations, agents, and approval-gated automations from one trusted command surface."><div className="onboard-points"><span><Mic size={16} /> Natural voice and text conversation</span><span><MemoryStick size={16} /> Transparent, user-controlled memory</span><span><ShieldCheck size={16} /> Human approval for consequential actions</span></div></OnboardSection>}
          {step === 1 && <OnboardSection icon={UserRound} eyebrow="Identity" title="How should MRE address you?" description="This is stored in your authenticated profile and can be changed later."><label className="field-label"><span>Display name</span><input autoFocus value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Your name" /></label><label className="field-label"><span>How MRE should address you</span><input value={preferredName} onChange={(event) => setPreferredName(event.target.value)} placeholder={displayName || "Preferred name"} /></label></OnboardSection>}
          {step === 2 && <OnboardSection icon={Volume2} eyebrow="Voice" title="Choose MRE’s voice" description="Only original system or configured synthetic voices are used—never an actor or copyrighted character imitation."><label className="field-label"><span>Available voice</span><select value={speech.selectedVoice} onChange={(event) => speech.setSelectedVoice(event.target.value)}>{!speech.voices.length && <option value="">Default professional voice</option>}{speech.voices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} · {voice.lang}</option>)}</select></label><button className="button button--secondary" type="button" onClick={() => speech.speak(`Hello ${preferredName || displayName || "there"}. I’m M R E, and your command workspace is nearly ready.`)}><Headphones size={15} /> Preview voice</button></OnboardSection>}
          {step === 3 && <OnboardSection icon={Mic} eyebrow="Microphone" title="Speak to MRE directly" description="Your browser will ask before sharing microphone access. A visible privacy indicator stays on whenever MRE is listening."><div className="permission-card"><span className={microphone.permission === "granted" ? "is-granted" : ""}><Mic size={20} /></span><div><strong>{microphone.permission === "granted" ? "Microphone ready" : "Permission required"}</strong><p>{microphone.error ?? "Audio is captured only after an explicit action. Text mode always remains available."}</p></div><button className="button button--primary" type="button" onClick={() => microphone.isListening ? microphone.stopListening(false) : void microphone.startListening()}>{microphone.permission === "granted" ? "Test again" : "Grant access"}</button></div></OnboardSection>}
          {step === 4 && <OnboardSection icon={Radio} eyebrow="Conversation mode" title="Choose how listening starts" description="Continuous conversation is always opt-in and clearly indicates when the microphone is active."><div className="choice-grid"><button className={mode === "push" ? "is-selected" : ""} type="button" onClick={() => setMode("push")}><span><Mic size={20} /></span><strong>Push to talk</strong><p>Hold the microphone or Space. Best for privacy and precise commands.</p><i>{mode === "push" && <Check size={13} />}</i></button><button className={mode === "continuous" ? "is-selected" : ""} type="button" onClick={() => setMode("continuous")}><span><Radio size={20} /></span><strong>Continuous</strong><p>Tap once for a natural back-and-forth. Stop at any time.</p><i>{mode === "continuous" && <Check size={13} />}</i></button></div></OnboardSection>}
          {step === 5 && <OnboardSection icon={MemoryStick} eyebrow="Persistent memory" title="You decide what MRE remembers" description="Useful facts can follow you across sessions and devices. Sensitive credentials and private secrets are excluded by default."><div className="memory-consent"><div><span><MemoryStick size={20} /></span><div><strong>Automatic memory suggestions</strong><p>Save relevant, non-sensitive long-term context with source and confidence details.</p></div></div><label className="switch-control"><input type="checkbox" checked={memoryEnabled} onChange={(event) => setMemoryEnabled(event.target.checked)} /><span aria-hidden="true" /><em>{memoryEnabled ? "Enabled" : "Disabled"}</em></label></div><div className="privacy-summary"><ShieldCheck size={16} /><p>You can search, edit, pin, expire, export, or delete every memory. Conversation history and long-term memory can be cleared independently.</p></div></OnboardSection>}
          {step === 6 && <OnboardSection icon={Link2} eyebrow="Optional integrations" title="Connect your working systems" description="Skip these for now or choose services to authorize after setup. Credentials never enter client-side code."><div className="onboard-integrations">{[{ id: "calendar", label: "Calendar", icon: CalendarDays }, { id: "drive", label: "Google Drive", icon: Database }, { id: "agents", label: "Business tools", icon: Bot }].map(({ id, label, icon: Icon }) => <button key={id} type="button" className={connected.includes(id) ? "is-selected" : ""} onClick={() => setConnected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])}><Icon size={18} /><span>{label}</span>{connected.includes(id) && <Check size={13} />}</button>)}</div></OnboardSection>}
          {step === 7 && <OnboardSection icon={Mic} eyebrow="Voice test" title="Say a quick hello" description="Press the microphone, say “Hello MRE,” and press again. Your caption should appear below."><button className={`onboard-mic ${microphone.isListening ? "is-active" : ""}`} type="button" onClick={() => microphone.isListening ? microphone.stopListening(true) : void microphone.startListening()}><Mic size={25} /><span>{microphone.isListening ? "Listening… tap to finish" : "Start voice test"}</span></button><div className="test-caption" aria-live="polite">{microphone.partialTranscript || testTranscript || "Your live caption will appear here."}</div></OnboardSection>}
          {step === 8 && <OnboardSection icon={Check} eyebrow="Setup complete" title={`MRE is ready${preferredName || displayName ? `, ${preferredName || displayName}` : ""}.`} description="Your command center is configured. You can revisit every choice from Settings and inspect all remembered context from Memory."><div className="ready-summary"><span><Check size={14} /> {mode === "continuous" ? "Hands-free conversation enabled" : "Push-to-talk selected"}</span><span><Check size={14} /> Persistent memory {memoryEnabled ? "enabled" : "disabled"}</span><span><Check size={14} /> {connected.length} optional integrations selected</span></div></OnboardSection>}
        </section>
      </main>

      {saveError && <div className="auth-error onboarding__save-error" role="alert">{saveError}</div>}
      <footer className="onboarding__footer"><button className="button button--secondary" type="button" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0}><ArrowLeft size={15} /> Back</button><span>Step {step + 1} of {steps.length}</span>{step < steps.length - 1 ? <button className="button button--primary" type="button" onClick={() => setStep((current) => current + 1)}>Continue <ArrowRight size={15} /></button> : <button className="button button--primary" type="button" onClick={() => void complete()} disabled={saving}>{saving ? "Saving…" : "Enter command center"} <ArrowRight size={15} /></button>}</footer>
    </div>
  );
}

function OnboardSection({ icon: Icon, eyebrow, title, description, children }: { icon: typeof Sparkles; eyebrow: string; title: string; description: string; children: React.ReactNode }) { return <div className="onboard-section"><span className="eyebrow"><Icon size={12} /> {eyebrow}</span><h1>{title}</h1><p className="onboard-section__description">{description}</p>{children}</div>; }
