import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Bot, MessageSquare, Minimize2, Plus, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { CopilotCitation } from "@/types/support";

export type CopilotChatInputMessage = {
  role: "user" | "assistant";
  content: string;
};

type ChatMessage = CopilotChatInputMessage & {
  id: string;
  createdAt: number;
  isError?: boolean;
  citations?: CopilotCitation[];
};

type ChatSession = {
  id: string;
  title: string;
  unreadCount: number;
  updatedAt: number;
  messages: ChatMessage[];
};

const QUICK_PROMPTS = [
  "What patterns are showing up in the queue today?",
  "Find similar tickets for a PCVR connection issue.",
  "Summarize recent Omni One return cases.",
];
const CHAT_DOCK_ANIMATION_MS = 280;

type DockPanelState = "closed" | "opening" | "open" | "closing";

function buildId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createMessage(role: "user" | "assistant", content: string, isError = false): ChatMessage {
  return {
    id: buildId("msg"),
    role,
    content,
    isError,
    createdAt: Date.now(),
  };
}

function createAssistantMessage(content: string, citations: CopilotCitation[] = [], isError = false): ChatMessage {
  return {
    ...createMessage("assistant", content, isError),
    citations,
  };
}

function createSession(index: number): ChatSession {
  const intro = createMessage(
    "assistant",
    "I can help summarize ticket history, compare similar cases, and answer support operations questions.",
  );
  return {
    id: buildId("session"),
    title: `Session ${index}`,
    unreadCount: 0,
    updatedAt: intro.createdAt,
    messages: [intro],
  };
}

function truncateLabel(value: string, max = 30): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function getDayBanner(timestamp: number): string {
  const now = new Date();
  const date = new Date(timestamp);
  const sameDay =
    now.getFullYear() === date.getFullYear() &&
    now.getMonth() === date.getMonth() &&
    now.getDate() === date.getDate();
  if (sameDay) return "Today";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function getTimeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function sortSessionsByUpdatedAt(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

function getLinkedTicketCitations(citations: CopilotCitation[] | undefined): CopilotCitation[] {
  if (!Array.isArray(citations) || citations.length === 0) return [];

  const seen = new Set<string>();
  const linked: CopilotCitation[] = [];
  for (const citation of citations) {
    if (citation.source_type !== "ticket" || !citation.url) continue;
    const key = citation.ticket_id !== null && citation.ticket_id !== undefined
      ? `ticket:${citation.ticket_id}`
      : `${citation.reference}:${citation.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    linked.push(citation);
  }
  return linked;
}

function getTicketCitationLabel(citation: CopilotCitation): string {
  if (citation.ticket_id !== null && citation.ticket_id !== undefined) {
    return `Ticket #${citation.ticket_id}`;
  }
  return citation.title;
}

function getSessionPreview(session: ChatSession): string {
  const latestMessage = session.messages[session.messages.length - 1];
  return truncateLabel(latestMessage?.content || "New conversation", 64);
}

function getSessionUpdatedLabel(timestamp: number): string {
  const now = new Date();
  const date = new Date(timestamp);
  const sameDay =
    now.getFullYear() === date.getFullYear() &&
    now.getMonth() === date.getMonth() &&
    now.getDate() === date.getDate();

  if (sameDay) {
    return getTimeLabel(timestamp);
  }

  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function CopilotChatDock({
  onAsk,
  onCitationClick,
}: {
  onAsk: (messages: CopilotChatInputMessage[]) => Promise<{ reply: string; citations: CopilotCitation[] }>;
  onCitationClick?: (citation: CopilotCitation) => void;
}) {
  const [sessions, setSessions] = useState<ChatSession[]>(() => [createSession(1)]);
  const [activeSessionId, setActiveSessionId] = useState<string>(() => "");
  const [panelState, setPanelState] = useState<DockPanelState>("closed");
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [notificationBanner, setNotificationBanner] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const openRef = useRef(false);
  const activeSessionRef = useRef(activeSessionId);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const isPanelOpen = panelState === "opening" || panelState === "open";
  const showPanel = panelState !== "closed";

  useEffect(() => {
    if (!activeSessionId && sessions.length > 0) {
      setActiveSessionId(sessions[0].id);
    }
  }, [activeSessionId, sessions]);

  useEffect(() => {
    openRef.current = isPanelOpen;
  }, [isPanelOpen]);

  useEffect(() => {
    activeSessionRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    return () => {
      if (openTimerRef.current !== null) {
        window.clearTimeout(openTimerRef.current);
      }
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  const orderedSessions = useMemo(() => sortSessionsByUpdatedAt(sessions), [sessions]);
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? orderedSessions[0] ?? null;
  const totalUnread = sessions.reduce((count, session) => count + session.unreadCount, 0);

  function clearOpenTimer() {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }

  function clearCloseTimer() {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }

  function openPanel() {
    clearCloseTimer();
    clearOpenTimer();
    if (panelState === "open" || panelState === "opening") {
      return;
    }
    setPanelState("opening");
    openTimerRef.current = window.setTimeout(() => {
      setPanelState("open");
      openTimerRef.current = null;
    }, CHAT_DOCK_ANIMATION_MS);
  }

  function closePanel() {
    clearOpenTimer();
    clearCloseTimer();
    if (panelState === "closed" || panelState === "closing") {
      return;
    }
    setPanelState("closing");
    closeTimerRef.current = window.setTimeout(() => {
      setPanelState("closed");
      closeTimerRef.current = null;
    }, CHAT_DOCK_ANIMATION_MS);
  }

  useEffect(() => {
    if (!activeSession) return;
    if (!isPanelOpen) return;

    setSessions((prev) => {
      let changed = false;
      const next = prev.map((session) => {
        if (session.id !== activeSession.id || session.unreadCount === 0) return session;
        changed = true;
        return { ...session, unreadCount: 0 };
      });
      return changed ? next : prev;
    });
    setNotificationBanner(null);
  }, [activeSession, isPanelOpen]);

  useEffect(() => {
    if (!activeSession) return;
    if (!isPanelOpen) return;
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeSession, isPanelOpen, sending]);

  function selectSession(sessionId: string) {
    setActiveSessionId(sessionId);
    openPanel();
  }

  function startNewSession() {
    const next = createSession(sessions.length + 1);
    setSessions((prev) => [next, ...prev]);
    setActiveSessionId(next.id);
    openPanel();
    setPrompt("");
  }

  async function sendPrompt() {
    const value = prompt.trim();
    if (!value || sending || !activeSession) return;

    const userMessage = createMessage("user", value);
    const history = [...activeSession.messages, userMessage].map((message) => ({
      role: message.role,
      content: message.content,
    }));

    setPrompt("");
    setSending(true);

    setSessions((prev) =>
      prev.map((session) => {
        if (session.id !== activeSession.id) return session;
        const autoTitle = session.title.startsWith("Session ") ? truncateLabel(value) : session.title;
        return {
          ...session,
          title: autoTitle,
          updatedAt: userMessage.createdAt,
          messages: [...session.messages, userMessage],
        };
      }),
    );

    try {
      const response = await onAsk(history);
      const assistantMessage = createAssistantMessage(response.reply, response.citations);
      const shouldMarkUnread = !openRef.current || activeSessionRef.current !== activeSession.id;

      setSessions((prev) =>
        prev.map((session) => {
          if (session.id !== activeSession.id) return session;
          return {
            ...session,
            updatedAt: assistantMessage.createdAt,
            unreadCount: shouldMarkUnread ? session.unreadCount + 1 : session.unreadCount,
            messages: [...session.messages, assistantMessage],
          };
        }),
      );

      if (shouldMarkUnread) {
        setNotificationBanner("New Copilot reply");
      }
    } catch (error) {
      const details = error instanceof Error ? error.message : "Copilot request failed.";
      const assistantMessage = createAssistantMessage(`Error: ${details}`, [], true);
      const shouldMarkUnread = !openRef.current || activeSessionRef.current !== activeSession.id;

      setSessions((prev) =>
        prev.map((session) => {
          if (session.id !== activeSession.id) return session;
          return {
            ...session,
            updatedAt: assistantMessage.createdAt,
            unreadCount: shouldMarkUnread ? session.unreadCount + 1 : session.unreadCount,
            messages: [...session.messages, assistantMessage],
          };
        }),
      );

      if (shouldMarkUnread) {
        setNotificationBanner("Copilot replied with an error");
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      {showPanel ? (
        <button
          type="button"
          aria-label="Close support copilot"
          className="fixed inset-0 z-40 bg-slate-950/18 backdrop-blur-[2px]"
          onClick={closePanel}
        />
      ) : null}

      <div className="fixed bottom-3 right-3 z-50 flex flex-col items-end gap-2 sm:bottom-4 sm:right-4">
      {!showPanel && notificationBanner ? (
        <div className="max-w-[250px] rounded-full border border-primary/40 bg-background/95 px-3 py-1 text-xs text-foreground shadow-lg backdrop-blur-sm">
          {notificationBanner}
        </div>
      ) : null}

      {!showPanel ? (
        <Button
          onClick={openPanel}
          className="chat-dock-fab relative h-14 w-14 rounded-full border border-primary/45 bg-primary/90 p-0 text-primary-foreground shadow-[0_18px_40px_-20px_hsl(var(--primary)/0.95)] transition hover:scale-[1.03] hover:bg-primary"
          aria-label="Open support copilot chat"
        >
          <MessageSquare className="h-6 w-6" />
          {totalUnread > 0 ? (
            <span className="absolute -right-1 -top-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[11px] font-semibold text-white">
              {Math.min(totalUnread, 9)}
            </span>
          ) : null}
        </Button>
      ) : (
        <section
          className={[
            "chat-dock-shell relative h-[min(88vh,820px)] w-[min(980px,calc(100vw-0.75rem))] overflow-hidden rounded-[1.6rem] border border-primary/24 bg-card/95 shadow-[0_40px_120px_-56px_rgba(0,0,0,0.98)] backdrop-blur-md",
            panelState === "opening" ? "chat-dock-enter" : "",
            panelState === "closing" ? "chat-dock-exit pointer-events-none" : "",
          ].join(" ")}
        >
          <div className="pointer-events-none absolute inset-0 rounded-[1.6rem] border border-primary/12" />
          <header className="border-b border-border/55 bg-gradient-to-r from-primary/18 via-card to-card px-4 py-4 sm:px-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-primary/30 bg-primary/20">
                  <Bot className="h-4 w-4 text-primary" />
                </span>
                <div>
                  <p className="text-base font-semibold tracking-tight">Support Copilot</p>
                  <p className="text-xs text-muted-foreground">Search ticket history, compare cases, and answer support questions.</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button size="icon" variant="ghost" onClick={startNewSession} aria-label="Start new chat">
                  <Plus className="h-4 w-4" />
                </Button>
                <Button size="icon" variant="ghost" onClick={closePanel} aria-label="Minimize chat">
                  <Minimize2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </header>

          <div className="grid h-[calc(100%-73px)] min-h-0 lg:grid-cols-[272px_minmax(0,1fr)]">
            <aside className="hidden min-h-0 border-r border-border/55 bg-background/82 lg:flex lg:flex-col">
              <div className="space-y-4 border-b border-border/55 px-4 py-4">
                <div className="rounded-[1.35rem] border border-primary/18 bg-gradient-to-br from-primary/[0.14] via-background/92 to-background/80 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">Copilot Workspace</p>
                  <p className="mt-2 text-xl font-semibold tracking-tight">{orderedSessions.length} chats</p>
                  <p className="mt-2 text-[12px] leading-5 text-muted-foreground">
                    Keep separate threads for queue triage, returns, PCVR issues, or investor questions.
                  </p>
                </div>

                <Button className="w-full justify-start gap-2" onClick={startNewSession}>
                  <Plus className="h-4 w-4" />
                  New conversation
                </Button>
              </div>

              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
                {orderedSessions.map((session) => (
                  <button
                    key={session.id}
                    onClick={() => selectSession(session.id)}
                    className={[
                      "w-full rounded-[1.15rem] border px-3 py-3 text-left transition",
                      session.id === activeSession?.id
                        ? "border-primary/45 bg-primary/[0.12] shadow-[0_18px_40px_-30px_hsl(var(--primary)/0.9)]"
                        : "border-border/65 bg-background/55 hover:border-primary/30 hover:bg-background/80",
                    ].join(" ")}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold tracking-tight">{truncateLabel(session.title, 24)}</p>
                      <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                        {getSessionUpdatedLabel(session.updatedAt)}
                      </span>
                    </div>
                    <p className="mt-2 text-[12px] leading-5 text-muted-foreground">{getSessionPreview(session)}</p>
                    {session.unreadCount > 0 ? (
                      <span className="mt-3 inline-flex min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                        {Math.min(session.unreadCount, 9)}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            </aside>

            <div className="flex min-h-0 flex-col">
              <div className="border-b border-border/55 bg-background/82 px-3 py-2 lg:hidden">
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {orderedSessions.map((session) => (
                    <button
                      key={session.id}
                      onClick={() => selectSession(session.id)}
                      className={[
                        "relative inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition",
                        session.id === activeSession?.id ? "border-primary/50 bg-primary/15 text-foreground" : "hover:bg-muted",
                      ].join(" ")}
                    >
                      <span>{truncateLabel(session.title, 22)}</span>
                      {session.unreadCount > 0 ? (
                        <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
                          {Math.min(session.unreadCount, 9)}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>

              <div className="border-b border-border/55 bg-gradient-to-b from-background/95 to-background/75 px-4 py-3 sm:px-5">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">Active Conversation</p>
                    <p className="mt-1 text-lg font-semibold tracking-tight">
                      {activeSession ? activeSession.title : "Support Copilot"}
                    </p>
                    <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
                      Ask naturally. Copilot will answer directly and link referenced tickets below the reply.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                    <span className="rounded-full border border-border/70 bg-background/75 px-2.5 py-1">Enter to send</span>
                    <span className="rounded-full border border-border/70 bg-background/75 px-2.5 py-1">Shift + Enter for newline</span>
                  </div>
                </div>
              </div>

              <div className="flex-1 min-h-0 space-y-4 overflow-y-auto px-4 py-4 sm:px-5 sm:py-5">
                {activeSession ? (
                  activeSession.messages.map((message, index) => {
                    const previous = index > 0 ? activeSession.messages[index - 1] : null;
                    const showBanner = !previous || getDayBanner(previous.createdAt) !== getDayBanner(message.createdAt);
                    const linkedTicketCitations = getLinkedTicketCitations(message.citations);

                    return (
                      <Fragment key={message.id}>
                        {showBanner ? (
                          <div className="my-2 flex justify-center">
                            <span className="rounded-full border bg-background/95 px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                              {getDayBanner(message.createdAt)}
                            </span>
                          </div>
                        ) : null}

                        <div className={message.role === "user" ? "ml-8 flex justify-end sm:ml-20" : "mr-8 flex justify-start sm:mr-28"}>
                          <div
                            className={[
                              "max-w-full rounded-[1.35rem] px-4 py-3 text-[14px] leading-6 shadow-sm sm:max-w-[90%]",
                              message.role === "user"
                                ? "rounded-br-md bg-primary text-primary-foreground shadow-[0_22px_48px_-30px_hsl(var(--primary)/0.95)]"
                                : message.isError
                                  ? "rounded-bl-md border border-destructive/30 bg-destructive/10 text-destructive"
                                  : "rounded-bl-md border border-border/65 bg-background/88 text-foreground shadow-[0_24px_50px_-36px_rgba(15,23,42,0.42)]",
                            ].join(" ")}
                          >
                            <p className="whitespace-pre-wrap">{message.content}</p>
                            {message.role === "assistant" && !message.isError && linkedTicketCitations.length > 0 ? (
                              <div className="mt-3 flex flex-wrap gap-2">
                                {linkedTicketCitations.map((citation, citationIndex) => (
                                  <a
                                    key={`${message.id}-ticket-link-${citationIndex}`}
                                    href={citation.url || undefined}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="rounded-full border border-primary/25 bg-background/70 px-3 py-1 text-[11px] font-medium text-foreground underline decoration-primary/45 underline-offset-2 hover:border-primary/40 hover:decoration-primary"
                                    onClick={() => onCitationClick?.(citation)}
                                  >
                                    {getTicketCitationLabel(citation)}
                                  </a>
                                ))}
                              </div>
                            ) : null}
                            <p className="mt-2 text-[10px] opacity-70">{getTimeLabel(message.createdAt)}</p>
                          </div>
                        </div>
                      </Fragment>
                    );
                  })
                ) : (
                  <p className="text-sm text-muted-foreground">No active session.</p>
                )}

                {sending ? (
                  <div className="mr-8 flex justify-start sm:mr-28">
                    <div className="rounded-[1.35rem] rounded-bl-md border border-border/65 bg-background/88 px-4 py-3 text-xs text-muted-foreground">
                      Copilot is typing…
                    </div>
                  </div>
                ) : null}
                <div ref={endRef} />
              </div>

              <div className="space-y-3 border-t border-border/55 bg-background/92 px-4 py-4 sm:px-5">
                <div className="flex flex-wrap gap-2">
                  {QUICK_PROMPTS.map((quickPrompt) => (
                    <Button
                      key={quickPrompt}
                      size="sm"
                      variant="outline"
                      className="h-8 rounded-full px-3 text-xs"
                      onClick={() => setPrompt(quickPrompt)}
                    >
                      <Sparkles className="mr-1 h-3 w-3" />
                      {truncateLabel(quickPrompt, 42)}
                    </Button>
                  ))}
                </div>

                <div className="rounded-[1.35rem] border border-border/65 bg-card/75 p-2 shadow-[0_22px_60px_-42px_rgba(15,23,42,0.45)]">
                  <div className="flex items-end gap-2">
                    <Textarea
                      value={prompt}
                      onChange={(event) => setPrompt(event.target.value)}
                      placeholder="Ask about returns, PCVR issues, order status, investor tickets, or similar historical cases…"
                      className="min-h-[112px] border-0 bg-transparent px-2 py-2 text-sm shadow-none focus-visible:ring-0"
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          void sendPrompt();
                        }
                      }}
                    />
                    <Button
                      className="h-12 min-w-12 rounded-full shadow-[0_18px_38px_-24px_hsl(var(--primary)/0.92)]"
                      size="icon"
                      onClick={() => void sendPrompt()}
                      disabled={sending || prompt.trim().length === 0}
                      aria-label="Send message"
                    >
                      <Send className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}
      </div>
    </>
  );
}
