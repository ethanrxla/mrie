"use client";

import { ArrowRight, Check, Eye, EyeOff, KeyRound, LockKeyhole, Mail, ShieldCheck, Sparkles, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AiCore } from "@/components/command/ai-core";
import { XynPrizeLogo } from "@/components/xynprize-logo";

export function LoginView() {
  const router = useRouter();
  const [registering, setRegistering] = useState(false);
  const [registrationAllowed, setRegistrationAllowed] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/status", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as { registrationAllowed?: boolean };
        setRegistrationAllowed(payload.registrationAllowed === true);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(registering ? "/api/auth/register" : "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(registering ? { email, displayName, password, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" } : { email, password }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string | { message?: string }; message?: string };
      if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : payload.error?.message ?? payload.message ?? "Sign-in was not accepted.");
      router.push(registering ? "/onboarding" : "/");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "MRE could not complete sign-in.");
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-page__ambient" aria-hidden="true" />
      <header><XynPrizeLogo /><span><ShieldCheck size={13} /> Encrypted command channel</span></header>
      <main className="login-shell">
        <section className="login-visual">
          <div className="login-visual__copy"><span className="eyebrow"><Sparkles size={12} /> XynPrize central intelligence</span><h1>One trusted surface for the work that matters.</h1><p>Speak, remember, coordinate, and approve—from a command center built around human control.</p></div>
          <AiCore state="idle" />
          <div className="login-trust"><span><Check size={13} /> Server-side memory</span><span><Check size={13} /> Approval-gated action</span><span><Check size={13} /> Provider-independent intelligence</span></div>
        </section>
        <section className="login-panel">
          <div className="login-panel__heading"><span><LockKeyhole size={20} /></span><h2>{registering ? "Create your command identity" : "Welcome back"}</h2><p>{registering ? "Set up an authenticated XynPrize workspace." : "Sign in to continue your conversations and memory."}</p></div>
          <form onSubmit={submit}>
            {registering && <label className="auth-field"><span>Display name</span><div><UserRound size={16} /><input autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Your name" minLength={2} required /></div></label>}
            <label className="auth-field"><span>Email address</span><div><Mail size={16} /><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@xynprize.com" required /></div></label>
            <label className="auth-field"><span>Password</span><div><KeyRound size={16} /><input type={showPassword ? "text" : "password"} autoComplete={registering ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={registering ? "12+ characters" : "Your password"} minLength={registering ? 12 : 8} required /><button type="button" onClick={() => setShowPassword((current) => !current)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
            {registering && <p className="password-guidance">Use 12 or more characters with uppercase, lowercase, and a number.</p>}
            {error && <div className="auth-error" role="alert">{error}</div>}
            <button className="button button--primary login-submit" type="submit" disabled={busy}>{busy ? "Securing session…" : registering ? "Create workspace" : "Enter command center"}<ArrowRight size={16} /></button>
          </form>
          <div className="login-divider"><span>Workspace access</span></div>
          {registrationAllowed ? (
            <button className="login-mode" type="button" onClick={() => { setRegistering((current) => !current); setError(null); }}>{registering ? "Already have an account? Sign in" : "New to XynPrize? Create an account"}</button>
          ) : (
            <p className="login-mode" aria-live="polite">Workspace registration is managed by an administrator.</p>
          )}
          <p className="login-privacy"><ShieldCheck size={13} /> Your credentials and provider keys never enter client-side application code.</p>
        </section>
      </main>
      <footer className="login-footer"><span>© 2026 XynPrize Ltd.</span><span>Original interface · Privacy first</span></footer>
    </div>
  );
}
