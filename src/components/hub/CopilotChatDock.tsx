import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Bot, MessageSquare, Minimize2, Plus, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export type CopilotChatInputMessage = {
  role: "user" | "assistant";
  content: string;
};

type ChatMessage = CopilotChatInputMessage & {
  id: string;
  createdAt: number;
  isError?: boolean;
};

type ChatSession = {
  id: string;
  title: string;
  unreadCount: number;
  updatedAt: number;
  messages: ChatMessage[];
};

const QUICK_PROMPTS = [
  "What should we prioritize in the queue today?",
  "Draft a short digest strategy for unresolved tickets.",
];

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

function createSession(index: number): ChatSession {
  const intro = createMessage(
    "assistant",
    "I can help with queue triage, digest planning, and action-oriented next steps.",
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

export function CopilotChatDock({
  onAsk,
}: {
  onAsk: (messages: CopilotChatInputMessage[]) => Promise<string>;
}) {
  const [sessions, setSessions] = useState<ChatSession[]>(() => [createSession(1)]);
  const [activeSessionId, setActiveSessionId] = useState<string>(() => "");
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [notificationBanner, setNotificationBanner] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const openRef = useRef(open);
  const activeSessionRef = useRef(activeSessionId);

  useEffect(() => {
    if (!activeSessionId && sessions.length > 0) {
      setActiveSessionId(sessions[0].id);
    }
  }, [activeSessionId, sessions]);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    activeSessionRef.current = activeSessionId;
  }, [activeSessionId]);

  const orderedSessions = useMemo(() => sortSessionsByUpdatedAt(sessions), [sessions]);
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? orderedSessions[0] ?? null;
  const totalUnread = sessions.reduce((count, session) => count + session.unreadCount, 0);

  useEffect(() => {
    if (!activeSession) return;
    if (!open) return;

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
  }, [activeSession, open]);

  useEffect(() => {
    if (!activeSession) return;
    if (!open) return;
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeSession, open, sending]);

  function selectSession(sessionId: string) {
    setActiveSessionId(sessionId);
    setOpen(true);
  }

  function startNewSession() {
    const next = createSession(sessions.length + 1);
    setSessions((prev) => [next, ...prev]);
    setActiveSessionId(next.id);
    setOpen(true);
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
      const reply = await onAsk(history);
      const assistantMessage = createMessage("assistant", reply);
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
      const assistantMessage = createMessage("assistant", `Error: ${details}`, true);
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
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
      {!open && notificationBanner ? (
        <div className="max-w-[250px] rounded-full border border-primary/40 bg-background/95 px-3 py-1 text-xs text-foreground shadow-lg backdrop-blur-sm">
          {notificationBanner}
        </div>
      ) : null}

      {!open ? (
        <Button
          onClick={() => setOpen(true)}
          className="relative h-14 w-14 rounded-full border border-primary/30 bg-primary/90 p-0 text-primary-foreground shadow-xl transition hover:scale-[1.03] hover:bg-primary"
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
        <section className="h-[min(74vh,680px)] w-[min(430px,calc(100vw-1rem))] rounded-2xl border bg-card/95 shadow-2xl backdrop-blur-md">
          <header className="border-b bg-gradient-to-r from-primary/15 via-card to-card px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-primary/30 bg-primary/20">
                  <Bot className="h-4 w-4 text-primary" />
                </span>
                <div>
                  <p className="text-sm font-semibold">Support Copilot</p>
                  <p className="text-xs text-muted-foreground">Live assistant chat</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button size="icon" variant="ghost" onClick={startNewSession} aria-label="Start new chat">
                  <Plus className="h-4 w-4" />
                </Button>
                <Button size="icon" variant="ghost" onClick={() => setOpen(false)} aria-label="Minimize chat">
                  <Minimize2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </header>

          <div className="border-b bg-background/80 px-3 py-2">
            <div className="flex gap-2 overflow-x-auto pb-1">
              {orderedSessions.map((session) => (
                <button
                  key={session.id}
                  onClick={() => selectSession(session.id)}
                  className={[
                    "relative inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1 text-xs transition",
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

          <div className="flex h-[calc(100%-126px)] flex-col">
            <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
              {activeSession ? (
                activeSession.messages.map((message, index) => {
                  const previous = index > 0 ? activeSession.messages[index - 1] : null;
                  const showBanner = !previous || getDayBanner(previous.createdAt) !== getDayBanner(message.createdAt);

                  return (
                    <Fragment key={message.id}>
                      {showBanner ? (
                        <div className="my-2 flex justify-center">
                          <span className="rounded-full border bg-background/95 px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                            {getDayBanner(message.createdAt)}
                          </span>
                        </div>
                      ) : null}

                      <div className={message.role === "user" ? "ml-10 flex justify-end" : "mr-10 flex justify-start"}>
                        <div
                          className={[
                            "max-w-full rounded-2xl px-3 py-2 text-sm shadow-sm",
                            message.role === "user"
                              ? "rounded-br-sm bg-primary text-primary-foreground"
                              : message.isError
                                ? "rounded-bl-sm border border-destructive/30 bg-destructive/10 text-destructive"
                                : "rounded-bl-sm border bg-muted/40 text-foreground",
                          ].join(" ")}
                        >
                          <p className="whitespace-pre-wrap">{message.content}</p>
                          <p className="mt-1 text-[10px] opacity-70">{getTimeLabel(message.createdAt)}</p>
                        </div>
                      </div>
                    </Fragment>
                  );
                })
              ) : (
                <p className="text-sm text-muted-foreground">No active session.</p>
              )}

              {sending ? (
                <div className="mr-10 flex justify-start">
                  <div className="rounded-2xl rounded-bl-sm border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    Copilot is typing…
                  </div>
                </div>
              ) : null}
              <div ref={endRef} />
            </div>

            <div className="space-y-2 border-t bg-background/90 px-3 py-3">
              <div className="flex flex-wrap gap-2">
                {QUICK_PROMPTS.map((quickPrompt) => (
                  <Button
                    key={quickPrompt}
                    size="sm"
                    variant="outline"
                    className="h-7 rounded-full px-3 text-xs"
                    onClick={() => setPrompt(quickPrompt)}
                  >
                    <Sparkles className="mr-1 h-3 w-3" />
                    {truncateLabel(quickPrompt, 28)}
                  </Button>
                ))}
              </div>

              <div className="flex items-end gap-2">
                <Textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Message Support Copilot…"
                  className="min-h-[82px] resize-none"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendPrompt();
                    }
                  }}
                />
                <Button size="icon" onClick={() => void sendPrompt()} disabled={sending || prompt.trim().length === 0} aria-label="Send message">
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
