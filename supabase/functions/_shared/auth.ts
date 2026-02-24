import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildAuthDebugSnapshot, logAuthDebug, type AuthDebugSnapshot } from "./auth_debug.ts";

const VIRTUIX_DOMAIN = "@virtuix.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

export type RequestAuth = {
  role: string;
  userId: string | null;
  email: string | null;
};

export class HttpError extends Error {
  status: number;
  code: string;
  publicDetails?: Record<string, unknown>;

  constructor(status: number, message: string, code = "http_error", publicDetails?: Record<string, unknown>) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.publicDetails = publicDetails;
  }
}

function getBearerToken(req: Request, authDebug: AuthDebugSnapshot): string {
  const authHeader = req.headers.get("authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) {
    throw new HttpError(401, "Missing Authorization bearer token.", "auth_missing_bearer_token", {
      auth_debug: authDebug,
    });
  }
  return match[1].trim();
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const payload = parts[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    const decoded = atob(payload);
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function authorizeVirtuixRequest(
  req: Request,
  options: { allowServiceRole?: boolean; functionName?: string } = {},
): Promise<RequestAuth> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new HttpError(500, "Missing Supabase auth configuration.", "auth_config_missing");
  }

  const authDebug = buildAuthDebugSnapshot(req, SUPABASE_URL);
  if (options.functionName) {
    logAuthDebug(options.functionName, authDebug);
  }

  const token = getBearerToken(req, authDebug);
  const claims = decodeJwtClaims(token);
  const role = typeof claims?.role === "string" ? claims.role : "";

  if (role === "service_role") {
    if (!options.allowServiceRole) {
      throw new HttpError(403, "Service-role token is not allowed for this action.", "auth_service_role_forbidden", {
        auth_debug: authDebug,
      });
    }
    if (!SUPABASE_SERVICE_ROLE_KEY) {
      throw new HttpError(500, "Missing service-role auth configuration.", "auth_service_role_config_missing", {
        auth_debug: authDebug,
      });
    }
    if (token !== SUPABASE_SERVICE_ROLE_KEY) {
      throw new HttpError(403, "Service-role token is invalid for this project.", "auth_service_role_invalid", {
        auth_debug: authDebug,
      });
    }
    return {
      role,
      userId: null,
      email: null,
    };
  }

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });

  const { data, error } = await authClient.auth.getUser();
  if (error || !data.user) {
    throw new HttpError(401, "Invalid or expired user token.", "auth_invalid_or_expired_user_token", {
      auth_debug: authDebug,
    });
  }

  const email = (data.user.email ?? "").toLowerCase();
  if (!email.endsWith(VIRTUIX_DOMAIN)) {
    throw new HttpError(403, "Access is restricted to @virtuix.com users.", "auth_forbidden_email_domain", {
      auth_debug: authDebug,
      email_domain: email.split("@")[1] ?? null,
    });
  }

  return {
    role: role || "authenticated",
    userId: data.user.id,
    email,
  };
}
