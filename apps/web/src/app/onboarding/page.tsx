import type { Metadata } from "next";

import { OnboardingView } from "@/components/pages/onboarding-view";

export const metadata: Metadata = { title: "Set up MRE" };

export default function OnboardingPage() {
  return <OnboardingView />;
}
