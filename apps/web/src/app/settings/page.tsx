import type { Metadata } from "next";

import { SettingsView } from "@/components/pages/settings-view";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return <SettingsView />;
}
