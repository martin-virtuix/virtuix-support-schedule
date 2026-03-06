import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeVirtuixRequest, HttpError } from "../_shared/auth.ts";

type EventBody = {
  event_name: string;
  route: string | null;
  metadata: Record<string, unknown>;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseBody(raw: unknown): EventBody {
  const body = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const eventName = normalizeOptionalString(body.event_name);
  if (!eventName) {
    throw new HttpError(400, "event_name is required.", "validation_event_name_required");
  }
  if (eventName.length > 120) {
    throw new HttpError(400, "event_name is too long (max 120).", "validation_event_name_too_long");
  }

  const route = normalizeOptionalString(body.route);
  const metadata = typeof body.metadata === "object" && body.metadata !== null ? body.metadata as Record<string, unknown> : {};

  return {
    event_name: eventName,
    route,
    metadata,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: "Missing Supabase service configuration." }, 500);
  }

  try {
    const auth = await authorizeVirtuixRequest(req, {
      allowServiceRole: true,
      functionName: "hub_analytics",
    });

    const body = parseBody(await req.json().catch(() => ({} as Record<string, unknown>)));

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const { error } = await supabaseAdmin
      .from("hub_analytics_events")
      .insert({
        event_name: body.event_name,
        route: body.route,
        metadata: body.metadata,
        user_id: auth.userId,
        user_email: auth.email,
      });

    if (error) {
      throw new Error(`Failed to store analytics event: ${error.message}`);
    }

    return jsonResponse({ ok: true });
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
    const message = error instanceof Error ? error.message : "Unknown analytics ingestion error";
    return jsonResponse({ error: message }, 500);
  }
});
