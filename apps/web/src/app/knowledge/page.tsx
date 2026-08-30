import type { Metadata } from "next";

import { KnowledgeView } from "@/components/pages/knowledge-view";

export const metadata: Metadata = { title: "Knowledge" };

export default function KnowledgePage() {
  return <KnowledgeView />;
}
