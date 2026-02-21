import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

type ChatContext = {
  omni_one_ticket_count?: number;
  omni_arena_ticket_count?: number;
  digest_count?: number;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function normalizeMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => {
      const role = item.role === "user" || item.role === "assistant" || item.role === "system"
        ? item.role
        : "user";
      const content = typeof item.content === "string" ? item.content.trim() : "";
      return { role, content };
    })
    .filter((item) => item.content.length > 0)
    .slice(-20);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (!OPENAI_API_KEY) {
    return jsonResponse({ error: "Missing OPENAI_API_KEY secret." }, 500);
  }

  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const messages = normalizeMessages(body.messages);
    const context = (typeof body.context === "object" && body.context !== null ? body.context : {}) as ChatContext;

    if (messages.length === 0) {
      return jsonResponse({ error: "messages[] is required." }, 400);
    }

    const systemPrompt = [
      "You are Virtuix Support Copilot.",
      "Be concise, practical, and action-oriented.",
      "Focus on queue triage, digest planning, and next best support actions.",
      "Prefer bullet points for plans and include specific next steps.",
      `Current context: omni_one=${context.omni_one_ticket_count ?? "unknown"}, omni_arena=${context.omni_arena_ticket_count ?? "unknown"}, digests=${context.digest_count ?? "unknown"}`,
    ].join(" ");

    const openAiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.25,
        messages: [
          { role: "system", content: systemPrompt },
          ...messages,
        ],
      }),
    });

    if (!openAiResponse.ok) {
      const text = await openAiResponse.text();
      return jsonResponse({ error: `OpenAI request failed (${openAiResponse.status}): ${text}` }, 500);
    }

    const payload = await openAiResponse.json() as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };

    const reply = payload.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      return jsonResponse({ error: "Empty response from model." }, 500);
    }

    return jsonResponse({
      ok: true,
      reply,
      model: OPENAI_MODEL,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown copilot error";
    return jsonResponse({ error: message }, 500);
  }
});
