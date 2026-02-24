import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { authorizeVirtuixRequest, HttpError } from "../_shared/auth.ts";
import { buildModelCandidates, requestChatCompletionWithModelFallback } from "../_shared/openai_chat.ts";

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
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL");
const OPENAI_MODEL_FALLBACKS = Deno.env.get("OPENAI_MODEL_FALLBACKS");

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

  try {
    await authorizeVirtuixRequest(req, { functionName: "copilot_chat" });

    if (!OPENAI_API_KEY) {
      return jsonResponse({ error: "Missing OPENAI_API_KEY secret." }, 500);
    }

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

    const modelCandidates = buildModelCandidates(OPENAI_MODEL, OPENAI_MODEL_FALLBACKS);
    const completion = await requestChatCompletionWithModelFallback({
      apiKey: OPENAI_API_KEY,
      modelCandidates,
      temperature: 0.25,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages,
      ],
    });

    return jsonResponse({
      ok: true,
      reply: completion.content,
      model: completion.model,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(
        {
          error: error.message,
          code: error.code,
          ...(error.publicDetails ?? {}),
        },
        error.status,
      );
    }
    const message = error instanceof Error ? error.message : "Unknown copilot error";
    return jsonResponse({ error: message }, 500);
  }
});
