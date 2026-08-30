import type { ChatAttachment } from "@/lib/chat/attachments";

export type MrieState =
  | "idle"
  | "listening"
  | "processing"
  | "speaking"
  | "success"
  | "error"
  | "offline";

export interface ChatMessage {
  id: string;
  serverId?: string;
  role: "user" | "assistant";
  content: string;
  attachments?: ChatAttachment[];
  createdAt: Date;
  sources?: Array<{ title: string; url?: string }>;
  memoryUsed?: Array<{ id: string; title: string }>;
  activity?: string;
  stopped?: boolean;
  memoryAction?: {
    status: string;
    commandText: string;
    message?: string;
    memories?: Array<{ id: string; title: string; content?: string }>;
  };
}
