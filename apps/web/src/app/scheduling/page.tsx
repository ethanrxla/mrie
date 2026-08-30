import type { Metadata } from "next";

import { SchedulingView } from "@/components/pages/scheduling-view";

export const metadata: Metadata = { title: "Scheduling" };

export default function SchedulingPage() {
  return <SchedulingView />;
}
