"use client";

import { AnimatePresence, motion } from "framer-motion";
import { LayoutGrid, MemoryStick, Menu, MessageSquareText, Newspaper, Settings, ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Sidebar } from "@/components/sidebar";
import { cn } from "@/components/ui/cn";
import { XynPrizeLogo } from "@/components/xynprize-logo";

const mobileNav = [
  { href: "/", label: "Command", icon: LayoutGrid },
  { href: "/conversations", label: "Chats", icon: MessageSquareText },
  { href: "/security", label: "Security", icon: ShieldCheck },
  { href: "/briefings", label: "Briefs", icon: Newspaper },
  { href: "/memory", label: "Memory", icon: MemoryStick },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileDrawerRef = useRef<HTMLDivElement>(null);

  const closeMobileNavigation = useCallback((restoreFocus = true) => {
    setMobileOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => mobileMenuButtonRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;

    const drawer = mobileDrawerRef.current;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => {
      drawer?.querySelector<HTMLElement>(
        "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      )?.focus();
    });

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMobileNavigation();
        return;
      }
      if (event.key !== "Tab" || !drawer) return;
      const focusable = Array.from(
        drawer.querySelectorAll<HTMLElement>(
          "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
        ),
      ).filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        drawer.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = priorOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeMobileNavigation, mobileOpen]);

  useEffect(() => {
    if (pathname === "/login" || pathname === "/onboarding") return;
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/auth/session", { signal: controller.signal }).then(async (response) => {
        if (!response.ok) return;
        const session = (await response.json()) as {
          authenticated?: boolean;
          user?: { onboardingComplete?: boolean } | null;
        };
        if (session.authenticated && session.user && !session.user.onboardingComplete) {
          router.replace("/onboarding");
        }
      }),
      fetch("/api/preferences", { signal: controller.signal }).then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as { preferences?: Record<string, unknown> };
        applyAccessibilityPreferences(payload.preferences ?? {});
      }),
    ]).catch(() => undefined);
    const handlePreference = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string; value: unknown }>).detail;
      if (detail) applyAccessibilityPreferences({ [detail.key]: detail.value });
    };
    window.addEventListener("mre:preference", handlePreference);
    return () => {
      controller.abort();
      window.removeEventListener("mre:preference", handlePreference);
    };
  }, [pathname, router]);

  if (pathname === "/onboarding" || pathname === "/login") {
    return <main id="main-content" className="onboarding-main" tabIndex={-1}>{children}</main>;
  }

  return (
    <div className={cn("app-frame", collapsed && "app-frame--collapsed")}>
      <div className="ambient-backdrop" aria-hidden="true">
        <span className="ambient-backdrop__grid" />
        <span className="ambient-backdrop__glow ambient-backdrop__glow--one" />
        <span className="ambient-backdrop__glow ambient-backdrop__glow--two" />
      </div>
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((current) => !current)} />
      <header className="mobile-header">
        <XynPrizeLogo />
        <button ref={mobileMenuButtonRef} className="icon-button" onClick={() => setMobileOpen(true)} type="button" aria-label="Open navigation" aria-expanded={mobileOpen} aria-controls="mobile-navigation-dialog">
          <Menu size={20} />
        </button>
      </header>
      <main id="main-content" className="app-main" tabIndex={-1}>
        {children}
      </main>
      <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
        {mobileNav.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link key={href} href={href} className={cn(active && "is-active")} aria-current={active ? "page" : undefined}>
              <Icon size={19} aria-hidden="true" />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>

      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              aria-hidden="true"
              className="mobile-drawer__scrim"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => closeMobileNavigation()}
            />
            <motion.div
              ref={mobileDrawerRef}
              id="mobile-navigation-dialog"
              className="mobile-drawer"
              role="dialog"
              aria-modal="true"
              aria-label="Primary navigation"
              tabIndex={-1}
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", damping: 28, stiffness: 280 }}
              onClick={(event) => {
                if ((event.target as HTMLElement).closest("a")) closeMobileNavigation();
              }}
            >
              <button className="icon-button mobile-drawer__close" onClick={() => closeMobileNavigation()} type="button" aria-label="Close navigation">
                <X size={20} />
              </button>
              <Sidebar collapsed={false} onToggle={() => closeMobileNavigation()} />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function applyAccessibilityPreferences(preferences: Record<string, unknown>) {
  const root = document.documentElement;
  if ("accessibility.highContrast" in preferences) {
    root.classList.toggle("mre-high-contrast", preferences["accessibility.highContrast"] === true);
  }
  if ("accessibility.reducedMotion" in preferences) {
    root.classList.toggle("mre-reduced-motion", preferences["accessibility.reducedMotion"] === true);
  }
}
