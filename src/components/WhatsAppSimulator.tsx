"use client";

import React, { useEffect, useRef, useState } from "react";
import type { ToolCallTrace } from "@/lib/types";

interface ChatMessage {
  id: string;
  sender: "bot" | "user";
  text: string;
  timestamp: string;
  toolCalls?: ToolCallTrace[];
  handedOff?: boolean;
  modelUsed?: string;
  debugError?: string;
}

interface WhatsAppSimulatorProps {
  storeSlug: string;
  storeName: string;
  greetingMessage: string;
  humanHandoffPhone: string;
  catalogCount: number;
  quickPrompts: string[];
  initialDebug: boolean;
  initialApiKeyMissing: boolean;
}

function formatCurrentTime(): string {
  return new Date().toLocaleTimeString("ar-SA", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function createSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Renders native WhatsApp `*bold*` (and safely renders `**bold**` if emitted) as `<strong>`.
 */
function renderWhatsAppBoldSegments(segment: string, keyPrefix: string): React.ReactNode[] {
  const boldRegex = /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
  const nodes: React.ReactNode[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = boldRegex.exec(segment)) !== null) {
    if (match.index > lastIdx) {
      nodes.push(segment.slice(lastIdx, match.index));
    }
    const boldText = match[1] ?? match[2] ?? "";
    nodes.push(
      <strong key={`${keyPrefix}_b_${match.index}`} className="font-bold text-slate-950">
        {boldText}
      </strong>
    );
    lastIdx = match.index + match[0].length;
  }

  if (lastIdx < segment.length) {
    nodes.push(segment.slice(lastIdx));
  }

  return nodes;
}

/**
 * Renders message text with clickable URLs AND native WhatsApp `*bold*` formatting.
 */
function renderMessageContent(text: string): React.ReactNode {
  const urlRegex = /(https?:\/\/[^\s<>")]+)/g;
  const parts = text.split(urlRegex);

  return parts.map((part, index) => {
    if (/^https?:\/\//i.test(part)) {
      const cleanUrl = part.replace(/[،.,؛:!؟*)]+$/, "");
      const trailing = part.slice(cleanUrl.length);
      return (
        <React.Fragment key={`part_${index}`}>
          <a
            href={cleanUrl}
            target="_blank"
            rel="noopener noreferrer"
            dir="ltr"
            className="inline-block text-[#027eb5] hover:text-[#015f8a] underline decoration-[#027eb5]/60 underline-offset-2 font-medium break-all"
          >
            {cleanUrl}
          </a>
          {renderWhatsAppBoldSegments(trailing, `trail_${index}`)}
        </React.Fragment>
      );
    }
    return (
      <React.Fragment key={`part_${index}`}>
        {renderWhatsAppBoldSegments(part, `seg_${index}`)}
      </React.Fragment>
    );
  });
}

export default function WhatsAppSimulator({
  storeSlug,
  storeName,
  greetingMessage,
  humanHandoffPhone,
  catalogCount,
  quickPrompts,
  initialDebug,
  initialApiKeyMissing,
}: WhatsAppSimulatorProps) {
  const [sessionId, setSessionId] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "greeting",
      sender: "bot",
      text: greetingMessage,
      timestamp: "الآن",
      toolCalls: [],
      handedOff: false,
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [handedOffSession, setHandedOffSession] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(initialDebug);
  const [apiKeyMissing, setApiKeyMissing] = useState(initialApiKeyMissing);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setSessionId(createSessionId());
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  async function sendMessage(rawText: string) {
    const trimmed = rawText.trim();
    if (!trimmed || isLoading) return;

    const activeSessionId = sessionId || createSessionId();
    if (!sessionId) setSessionId(activeSessionId);

    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      sender: "user",
      text: trimmed,
      timestamp: formatCurrentTime(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setErrorBanner(null);
    setIsLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeSlug,
          sessionId: activeSessionId,
          message: trimmed,
        }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.reply) {
        setErrorBanner("تعذر إرسال الرسالة حالياً، يرجى المحاولة بعد لحظات.");
        return;
      }

      if (data.apiKeyMissing) {
        setApiKeyMissing(true);
      } else {
        setApiKeyMissing(false);
      }

      if (data.handedOff) {
        setHandedOffSession(true);
      }

      const botMsg: ChatMessage = {
        id: `b_${Date.now()}`,
        sender: "bot",
        text: String(data.reply),
        timestamp: formatCurrentTime(),
        toolCalls: Array.isArray(data.toolCalls) ? data.toolCalls : [],
        handedOff: Boolean(data.handedOff),
        modelUsed: typeof data.modelUsed === "string" ? data.modelUsed : undefined,
        debugError: typeof data.debugError === "string" ? data.debugError : undefined,
      };

      setMessages((prev) => [...prev, botMsg]);
    } catch {
      setErrorBanner("حدث خطأ في الشبكة أثناء إرسال الرسالة. حاول مرة أخرى.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleResetConversation() {
    if (sessionId) {
      await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeSlug,
          sessionId,
          action: "reset",
        }),
      }).catch(() => undefined);
    }

    const freshSession = createSessionId();
    setSessionId(freshSession);
    setHandedOffSession(false);
    setErrorBanner(null);
    setMessages([
      {
        id: `greeting_${Date.now()}`,
        sender: "bot",
        text: greetingMessage,
        timestamp: formatCurrentTime(),
        toolCalls: [],
        handedOff: false,
      },
    ]);
  }

  const inspectorTurns = messages
    .filter(
      (m) =>
        m.sender === "bot" &&
        m.id !== "greeting" &&
        !m.id.startsWith("greeting_") &&
        (Boolean(m.modelUsed) ||
          Boolean(m.debugError) ||
          (m.toolCalls && m.toolCalls.length > 0))
    )
    .map((m) => ({
      messageId: m.id,
      timestamp: m.timestamp,
      handedOff: m.handedOff,
      modelUsed: m.modelUsed ?? "unknown",
      debugError: m.debugError,
      toolCalls: m.toolCalls ?? [],
    }));

  return (
    <div className="min-h-screen bg-[#e5ddd5] sm:bg-slate-200 flex flex-col items-center justify-start sm:py-4 sm:px-4">
      {/* Missing API Key Banner */}
      {apiKeyMissing && (
        <div className="w-full max-w-5xl mb-2 px-3 sm:px-0">
          <div className="rounded-xl border border-amber-400 bg-amber-50 text-amber-950 px-4 py-3 shadow-sm text-xs sm:text-sm flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <span className="font-bold">⚠️ مفتاح GEMINI_API_KEY غير مضبوط في .env.local: </span>
              <span>
                يرجى إنشاء ملف{" "}
                <code className="bg-amber-200/70 px-1.5 py-0.5 rounded font-mono" dir="ltr">
                  .env.local
                </code>{" "}
                وإضافة{" "}
                <code className="bg-amber-200/70 px-1.5 py-0.5 rounded font-mono" dir="ltr">
                  GEMINI_API_KEY=...
                </code>{" "}
                ثم إعادة تشغيل السيرفر لتفعيل الردود الذكية.
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Main Container (Mobile-first WhatsApp frame + optional Collapsible Developer Inspector) */}
      <div
        className={`w-full ${
          inspectorOpen ? "max-w-5xl grid lg:grid-cols-[1fr_400px] gap-4" : "max-w-md"
        } flex-1 sm:flex-initial`}
      >
        {/* WhatsApp Phone Frame */}
        <div className="flex flex-col h-[100dvh] sm:h-[86vh] sm:min-h-[640px] sm:max-h-[820px] bg-[#efeae2] sm:rounded-2xl shadow-xl overflow-hidden border border-black/10">
          {/* WhatsApp Header */}
          <header className="bg-[#075e54] text-white px-3.5 py-2.5 flex items-center justify-between gap-2 shadow-md z-10">
            <div className="flex items-center gap-3 min-w-0">
              <div className="relative shrink-0">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-amber-200 via-yellow-400 to-amber-600 text-slate-900 font-bold flex items-center justify-center text-base shadow-inner">
                  ✨
                </div>
                <span
                  className="absolute bottom-0 left-0 w-3 h-3 rounded-full bg-[#25d366] ring-2 ring-[#075e54]"
                  title="متصل الآن"
                />
              </div>

              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="font-bold text-sm sm:text-base truncate">{storeName}</h1>
                  <span className="shrink-0 text-[10px] font-semibold bg-emerald-400/20 border border-emerald-300/40 text-emerald-100 px-2 py-0.5 rounded-full">
                    تجربة تفاعلية
                  </span>
                </div>
                <p className="text-[11px] text-emerald-100/90 flex items-center gap-1.5">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#25d366]" />
                  <span>متصل الآن • مستشار المبيعات الذكي ({catalogCount} قطع)</span>
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => setInspectorOpen((v) => !v)}
                className={`text-[11px] px-2.5 py-1.5 rounded-lg border transition cursor-pointer ${
                  inspectorOpen
                    ? "bg-white text-[#075e54] border-white font-semibold"
                    : "bg-white/10 hover:bg-white/20 text-white/90 border-white/20"
                }`}
                title="فاحص الأدوات للمطورين (Zero-Hallucination Inspector)"
              >
                {inspectorOpen ? "إخفاء الفاحص" : "🛠️ الفاحص"}
              </button>

              <button
                type="button"
                onClick={handleResetConversation}
                className="text-[11px] px-2 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white/90 border border-white/15 transition cursor-pointer"
                title="بدء محادثة جديدة"
              >
                جديد ↺
              </button>
            </div>
          </header>

          {/* Session Handoff Status Banner */}
          {handedOffSession && (
            <div className="bg-amber-100 border-b border-amber-300 px-3.5 py-2 flex items-center justify-between gap-2 text-xs text-amber-950">
              <div className="flex items-center gap-2 font-semibold">
                <span>👤</span>
                <span>تم تحويل المحادثة لموظف المبيعات</span>
              </div>
              <span className="font-mono text-[11px] text-amber-900" dir="ltr">
                {humanHandoffPhone}
              </span>
            </div>
          )}

          {/* Chat Wallpaper & Messages */}
          <div className="flex-1 overflow-y-auto px-3 py-4 space-y-3 wa-chat-wallpaper">
            {/* Encryption-style reassurance pill */}
            <div className="flex justify-center">
              <div className="bg-[#fff5c4] text-slate-700 text-[11px] px-3 py-1 rounded-lg shadow-xs text-center max-w-xs">
                🔒 جميع الأسعار والأوزان وحالة التوفر مرتبطة مباشرة بكتالوج المتجر الفعلي دون تخمين.
              </div>
            </div>

            {messages.map((msg) => {
              const isUser = msg.sender === "user";
              return (
                <div
                  key={msg.id}
                  className={`flex flex-col ${isUser ? "items-start" : "items-end"}`}
                >
                  <div
                    className={`relative max-w-[85%] rounded-2xl px-3.5 py-2.5 shadow-xs text-sm leading-relaxed ${
                      isUser
                        ? "bg-[#d9fdd3] text-slate-900 rounded-tr-xs"
                        : "bg-white text-slate-900 rounded-tl-xs"
                    }`}
                  >
                    <div className="whitespace-pre-wrap break-words">
                      {renderMessageContent(msg.text)}
                    </div>

                    {/* Visual badge when message triggered human handoff */}
                    {msg.handedOff && (
                      <div className="mt-2.5 pt-2 border-t border-amber-200 flex items-center gap-1.5 text-xs font-semibold text-amber-800 bg-amber-50 px-2.5 py-1.5 rounded-lg">
                        <span>🙋‍♂️</span>
                        <span>تم تحويل المحادثة لموظف المبيعات</span>
                      </div>
                    )}

                    <div className="mt-1 flex items-center justify-end gap-1.5 text-[10px] text-slate-500">
                      {!isUser && msg.toolCalls && msg.toolCalls.length > 0 && inspectorOpen && (
                        <span className="bg-emerald-50 text-emerald-700 border border-emerald-200 px-1.5 py-0.2 rounded font-mono">
                          {msg.toolCalls.length} tool{msg.toolCalls.length > 1 ? "s" : ""}
                        </span>
                      )}
                      <span>{msg.timestamp}</span>
                      {isUser && <span className="text-[#53bdeb] text-xs">✓✓</span>}
                    </div>
                  </div>
                </div>
              );
            })}

            {isLoading && (
              <div className="flex items-end justify-end">
                <div className="bg-white text-slate-600 rounded-2xl rounded-tl-xs px-4 py-2.5 shadow-xs text-xs flex items-center gap-2">
                  <span className="inline-flex gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 animate-bounce" />
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 animate-bounce [animation-delay:150ms]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 animate-bounce [animation-delay:300ms]" />
                  </span>
                  <span>جاري التحقق من الكتالوج والرد...</span>
                </div>
              </div>
            )}

            {errorBanner && (
              <div className="bg-red-50 border border-red-200 text-red-800 text-xs rounded-xl px-3 py-2 text-center">
                {errorBanner}
              </div>
            )}

            <div ref={chatEndRef} />
          </div>

          {/* Quick-test Prompt Chips */}
          <div className="bg-[#f0f2f5] border-t border-slate-200/80 px-2.5 pt-2 pb-1">
            <div className="flex gap-1.5 overflow-x-auto pb-1 no-scrollbar">
              {quickPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  disabled={isLoading}
                  onClick={() => sendMessage(prompt)}
                  className="shrink-0 text-xs bg-white hover:bg-emerald-50 active:bg-emerald-100 text-[#075e54] border border-emerald-700/20 rounded-full px-3 py-1.5 shadow-2xs transition disabled:opacity-50 cursor-pointer"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>

          {/* Composer Bar */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage(input);
            }}
            className="bg-[#f0f2f5] px-2.5 py-2 flex items-center gap-2"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="اكتب رسالتك هنا..."
              disabled={isLoading}
              className="flex-1 bg-white rounded-full px-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#075e54]/30 shadow-2xs disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              aria-label="إرسال"
              className="w-10 h-10 rounded-full bg-[#075e54] hover:bg-[#064e46] disabled:bg-slate-400 text-white flex items-center justify-center shadow-sm transition shrink-0 cursor-pointer"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                className="w-5 h-5 -scale-x-100"
              >
                <path d="M3.478 2.404a.75.75 0 0 0-.926.941l2.432 7.905H13.5a.75.75 0 0 1 0 1.5H4.984l-2.432 7.905a.75.75 0 0 0 .926.94 60.519 60.519 0 0 0 18.445-8.986.75.75 0 0 0 0-1.218A60.517 60.517 0 0 0 3.478 2.404Z" />
              </svg>
            </button>
          </form>
        </div>

        {/* Collapsible Developer Inspector Panel (OFF by default unless toggled or ?debug=1) */}
        {inspectorOpen && (
          <aside
            dir="ltr"
            className="bg-slate-900 text-slate-100 sm:rounded-2xl shadow-xl border border-slate-800 flex flex-col h-[50vh] lg:h-[86vh] lg:min-h-[640px] lg:max-h-[820px] overflow-hidden"
          >
            <div className="px-4 py-3 bg-slate-950 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h2 className="text-xs font-bold uppercase tracking-wider text-emerald-400">
                  Developer Inspector
                </h2>
                <p className="text-[11px] text-slate-400">
                  Zero-Hallucination Tool &amp; Model Audit Log
                </p>
              </div>
              <span className="text-[11px] font-mono bg-slate-800 px-2 py-0.5 rounded text-slate-300">
                store: {storeSlug}
              </span>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-3 text-xs font-mono">
              {inspectorTurns.length === 0 ? (
                <div className="text-slate-400 p-4 text-center leading-relaxed font-sans text-xs">
                  No turns recorded yet. Click any quick-test chip or send a message to inspect
                  which Gemini model handled the turn, function arguments, and JSON tool responses.
                </div>
              ) : (
                inspectorTurns.map((turn, gIdx) => (
                  <div
                    key={turn.messageId}
                    className="rounded-xl bg-slate-950/80 border border-slate-800 p-3 space-y-2.5"
                  >
                    <div className="flex items-center justify-between gap-2 flex-wrap text-[11px] text-slate-400 border-b border-slate-800 pb-1.5">
                      <span>Turn #{gIdx + 1}</span>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="bg-indigo-500/20 text-indigo-300 border border-indigo-400/30 px-2 py-0.5 rounded text-[10px]">
                          model: {turn.modelUsed}
                        </span>
                        {turn.handedOff && (
                          <span className="bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded text-[10px]">
                            HANDED_OFF
                          </span>
                        )}
                      </div>
                    </div>

                    {turn.debugError && (
                      <div className="rounded-lg bg-red-950/60 border border-red-800/70 p-2 text-[11px] text-red-200 break-words">
                        <div className="font-bold text-red-400 mb-0.5">debugError (hidden from customer):</div>
                        {turn.debugError}
                      </div>
                    )}

                    {turn.toolCalls.length === 0 && !turn.debugError ? (
                      <div className="text-[11px] text-slate-500 italic">
                        Direct model reply (no tool calls invoked on this turn).
                      </div>
                    ) : (
                      turn.toolCalls.map((tc, idx) => (
                        <div key={idx} className="space-y-1.5">
                          <div className="text-emerald-300 font-semibold">
                            fn: {tc.name}()
                          </div>
                          <div>
                            <div className="text-[10px] text-slate-400 mb-0.5">args:</div>
                            <pre className="bg-slate-900 p-2 rounded border border-slate-800 overflow-x-auto text-[11px] text-sky-200">
                              {JSON.stringify(tc.args, null, 2)}
                            </pre>
                          </div>
                          <div>
                            <div className="text-[10px] text-slate-400 mb-0.5">result:</div>
                            <pre className="bg-slate-900 p-2 rounded border border-slate-800 overflow-x-auto max-h-48 text-[11px] text-emerald-200">
                              {JSON.stringify(tc.result, null, 2)}
                            </pre>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                ))
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
