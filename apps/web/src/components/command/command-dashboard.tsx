"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  Bell,
  ChevronRight,
  Command,
  PanelRightOpen,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AiCore } from "@/components/command/ai-core";
import { IntelligencePanel, IntelligencePanelRail } from "@/components/command/intelligence-panel";
import { Transcript } from "@/components/command/transcript";
import type { ChatMessage, MrieState } from "@/components/command/types";
import { VoiceComposer } from "@/components/command/voice-composer";
import { useMicrophone } from "@/components/hooks/use-microphone";
import { useInterfaceSounds } from "@/components/hooks/use-interface-sounds";
import { useSpeechOutput } from "@/components/hooks/use-speech-output";
import { useStreamingChat } from "@/components/hooks/use-streaming-chat";
import { cn } from "@/components/ui/cn";
import type { ChatAttachment } from "@/lib/chat/attachments";

export function CommandDashboard() {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [intelligenceOpen, setIntelligenceOpen] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const restoredConversationRef = useRef<string | null>(null);
  const previousChatStateRef = useRef<MrieState>("idle");
  const playTone = useInterfaceSounds();
  const speech = useSpeechOutput();
  const chat = useStreamingChat({ onComplete: speech.speak });
  const sendMessage = chat.sendMessage;
  const loadConversation = chat.loadConversation;
  const newConversation = chat.newConversation;

  useEffect(() => {
    const desktopPanel = window.matchMedia("(min-width: 1281px)");
    const applyDefaultPanelState = () => setIntelligenceOpen(desktopPanel.matches);
    const animationFrame = window.requestAnimationFrame(applyDefaultPanelState);
    desktopPanel.addEventListener("change", applyDefaultPanelState);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      desktopPanel.removeEventListener("change", applyDefaultPanelState);
    };
  }, []);

  const submitVoiceTranscript = useCallback(
    (transcript: string) => {
      setDraft("");
      setAttachments([]);
      void sendMessage(transcript, attachments);
    },
    [attachments, sendMessage],
  );

  const microphone = useMicrophone({
    onFinalTranscript: submitVoiceTranscript,
    onStart: () => {
      void playTone("listen");
      speech.stop();
      chat.stopGeneration();
      chat.setState("listening");
      chat.setStatusText("Listening");
    },
    onStop: () => {
      chat.setState("processing");
      chat.setStatusText("Transcribing");
    },
    onNoSpeech: () => {
      chat.setState("idle");
      chat.setStatusText("Ready");
    },
    autoStopOnSilence: handsFree,
  });
  const microphoneIsListening = microphone.isListening;
  const microphoneIsTranscribing = microphone.isTranscribing;
  const startMicrophone = microphone.startListening;

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/preferences", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as { preferences?: Record<string, unknown> };
        if (typeof payload.preferences?.["voice.handsFree"] === "boolean") {
          setHandsFree(payload.preferences["voice.handsFree"] as boolean);
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const focusComposer = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      window.dispatchEvent(new Event("mre:focus-composer"));
    };
    window.addEventListener("keydown", focusComposer);
    return () => window.removeEventListener("keydown", focusComposer);
  }, []);

  useEffect(() => {
    if (
      !handsFree ||
      microphoneIsListening ||
      microphoneIsTranscribing ||
      chat.isGenerating ||
      speech.speaking ||
      chat.state !== "idle"
    ) return;
    const timer = window.setTimeout(() => void startMicrophone(), 550);
    return () => window.clearTimeout(timer);
  }, [
    chat.isGenerating,
    chat.state,
    handsFree,
    microphoneIsListening,
    microphoneIsTranscribing,
    startMicrophone,
    speech.speaking,
  ]);

  useEffect(() => {
    if (previousChatStateRef.current !== chat.state) {
      if (chat.state === "success") void playTone("complete");
      if (chat.state === "error") void playTone("warning");
      previousChatStateRef.current = chat.state;
    }
  }, [chat.state, playTone]);

  useEffect(() => {
    const reset = () => {
      newConversation();
      restoredConversationRef.current = null;
      window.history.replaceState({}, "", "/");
    };
    window.addEventListener("mre:new-conversation", reset);
    const parameters = new URLSearchParams(window.location.search);
    const conversation = parameters.get("conversation");
    const prompt = parameters.get("prompt");
    if (prompt) window.setTimeout(() => setDraft(prompt.slice(0, 12_000)), 0);
    if (parameters.get("new") === "true") {
      reset();
    } else if (conversation && restoredConversationRef.current !== conversation) {
      restoredConversationRef.current = conversation;
      void loadConversation(conversation);
    }
    return () => window.removeEventListener("mre:new-conversation", reset);
  }, [loadConversation, newConversation]);

  const coreState: MrieState = microphone.isListening
    ? "listening"
    : speech.speaking
      ? "speaking"
      : chat.state;
  const audioLevel = microphone.isListening ? microphone.inputLevel : speech.level;

  const sendDraft = () => {
    const outgoing = draft.trim() || (attachments.length ? "Review the attached files." : "");
    if (!outgoing) return;
    setDraft("");
    const outgoingAttachments = attachments;
    setAttachments([]);
    void playTone("process");
    speech.stop();
    void chat.sendMessage(outgoing, outgoingAttachments);
  };

  const updateHandsFree = (enabled: boolean) => {
    setHandsFree(enabled);
    window.dispatchEvent(
      new CustomEvent("mre:preference", {
        detail: { key: "voice.handsFree", value: enabled },
      }),
    );
    void fetch("/api/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "voice.handsFree", value: enabled }),
    }).catch(() => undefined);
  };

  const retry = (assistantMessage: ChatMessage) => {
    const index = chat.messages.findIndex((message) => message.id === assistantMessage.id);
    const priorUserMessage = [...chat.messages.slice(0, index)].reverse().find((message) => message.role === "user");
    if (priorUserMessage) void chat.sendMessage(priorUserMessage.content, priorUserMessage.attachments);
  };

  const statusLabel = useMemo(() => {
    if (microphone.isListening) return "Listening";
    if (speech.speaking) return "Speaking";
    return chat.statusText;
  }, [chat.statusText, microphone.isListening, speech.speaking]);
  const latestMemoryUsed = useMemo(
    () => [...chat.messages].reverse().find((message) => message.role === "assistant" && message.memoryUsed?.length)?.memoryUsed ?? [],
    [chat.messages],
  );

  return (
    <div className={cn("command-dashboard", !intelligenceOpen && "command-dashboard--wide")}>
      <div className="command-center">
        <header className="command-header">
          <div>
            <div className="breadcrumbs"><span>Command center</span><ChevronRight size={12} /><strong>Live workspace</strong></div>
            <h1><span>MRE command channel.</span> What should we focus on?</h1>
          </div>
          <div className="command-header__actions">
            <button className="command-search" type="button" onClick={() => window.dispatchEvent(new Event("mre:focus-composer"))}><Search size={15} /><span>Ask MRE</span><kbd><Command size={11} /> K</kbd></button>
            <span className="secure-chip"><ShieldCheck size={13} /> Secure</span>
            <Link className="icon-button notification-button" href="/automations" aria-label="Open workflow activity"><Bell size={17} /></Link>
            {!intelligenceOpen && <button className="icon-button" type="button" onClick={() => setIntelligenceOpen(true)} aria-label="Open intelligence panel"><PanelRightOpen size={18} /></button>}
          </div>
        </header>

        <div className="command-canvas">
          {chat.historyError && <div className="inline-notice inline-notice--warning command-history-notice" role="status"><span>{chat.historyError}</span></div>}
          <div className="core-column">
            <div className="core-status" aria-live="polite">
              <span className={`core-status__signal core-status__signal--${coreState}`} aria-hidden="true" />
              <span>{statusLabel}</span>
            </div>
            <AiCore state={coreState} audioLevel={audioLevel} />
            <div className="quick-prompts" aria-label="Suggested prompts">
              <button type="button" onClick={() => setDraft("Report your current model and voice status.")}><Sparkles size={13} /> System status</button>
              <button type="button" onClick={() => setDraft("What do you remember about me?")}><ShieldCheck size={13} /> Review memory</button>
              <button type="button" onClick={() => setDraft("What can you do right now?")}><Command size={13} /> Capabilities</button>
            </div>
          </div>

          <Transcript
            messages={chat.messages}
            speaking={speech.speaking}
            onSpeak={speech.speak}
            onStopSpeaking={speech.stop}
            onRetry={retry}
            onEdit={(message) => {
              setDraft(message.content);
              setAttachments(message.attachments ?? []);
            }}
          />

          <VoiceComposer
            value={draft}
            onChange={setDraft}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            onSend={sendDraft}
            isGenerating={chat.isGenerating}
            onStopGeneration={chat.stopGeneration}
            isListening={microphone.isListening}
            onStartListening={microphone.startListening}
            onStopListening={microphone.stopListening}
            partialTranscript={microphone.partialTranscript}
            inputLevel={microphone.inputLevel}
            noiseState={microphone.noiseState}
            permission={microphone.permission}
            microphoneError={microphone.error}
            devices={microphone.devices}
            selectedDeviceId={microphone.selectedDeviceId}
            onSelectDevice={microphone.setSelectedDeviceId}
            transcriptionSupported={microphone.speechRecognitionSupported}
            speechError={speech.error}
            muted={speech.muted}
            onMutedChange={speech.setMuted}
            voices={speech.voices}
            selectedVoice={speech.selectedVoice}
            onSelectVoice={speech.setSelectedVoice}
            voiceRate={speech.rate}
            onVoiceRateChange={speech.setRate}
            onInterruptAudio={speech.stop}
            handsFree={handsFree}
            onHandsFreeChange={updateHandsFree}
          />
        </div>
      </div>

      <AnimatePresence initial={false} mode="popLayout">
        {intelligenceOpen ? (
          <motion.div key="panel" className="intelligence-wrap" initial={{ opacity: 0, width: 0 }} animate={{ opacity: 1, width: 352 }} exit={{ opacity: 0, width: 0 }} transition={{ duration: 0.22 }}>
            <IntelligencePanel onCollapse={() => setIntelligenceOpen(false)} memoryUsed={latestMemoryUsed} />
          </motion.div>
        ) : (
          <motion.div key="rail" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <IntelligencePanelRail onExpand={() => setIntelligenceOpen(true)} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
