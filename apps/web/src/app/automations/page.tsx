import type { Metadata } from "next";

import { AutomationsView } from "@/components/pages/automations-view";

export const metadata: Metadata = { title: "Automations" };

export default function AutomationsPage() {
  return <AutomationsView />;
}
