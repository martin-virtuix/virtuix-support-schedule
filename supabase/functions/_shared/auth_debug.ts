type JwtClaims = {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  sub?: unknown;
  ref?: unknown;
  role?: unknown;
};

type PublicClaims = {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  sub?: string;
  ref?: string;
  role?: string;
};

export type AuthDebugSnapshot = {
  has_authorization_header: boolean;
  authorization_scheme: string | null;
  token_prefix: string | null;
  token_kind: "missing" | "jwt" | "non_jwt";
  claims: PublicClaims | null;
  expected_project_ref: string | null;
  token_project_ref: string | null;
  project_ref_matches: boolean | null;
  token_expired: boolean | null;
};

function parseJwtClaims(token: string): JwtClaims | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;

  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const decoded = atob(padded);
    return JSON.parse(decoded) as JwtClaims;
  } catch {
    return null;
  }
}

function parseNumericClaim(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function extractProjectRefFromSupabaseUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.hostname.split(".")[0] || null;
  } catch {
    return null;
  }
}

function extractProjectRefFromIssuer(issuer: unknown): string | null {
  if (typeof issuer !== "string" || issuer.length === 0 || issuer === "supabase") return null;
  try {
    const parsed = new URL(issuer);
    return parsed.hostname.split(".")[0] || null;
  } catch {
    return null;
  }
}

function toPublicClaims(claims: JwtClaims): PublicClaims {
  return {
    iss: typeof claims.iss === "string" ? claims.iss : undefined,
    aud:
      typeof claims.aud === "string"
        ? claims.aud
        : Array.isArray(claims.aud)
          ? claims.aud.filter((value): value is string => typeof value === "string")
          : undefined,
    exp: parseNumericClaim(claims.exp),
    sub: typeof claims.sub === "string" ? claims.sub : undefined,
    ref: typeof claims.ref === "string" ? claims.ref : undefined,
    role: typeof claims.role === "string" ? claims.role : undefined,
  };
}

export function buildAuthDebugSnapshot(req: Request, supabaseUrl: string | null | undefined): AuthDebugSnapshot {
  const authHeader = req.headers.get("authorization");
  const hasHeader = typeof authHeader === "string" && authHeader.trim().length > 0;

  const [schemeRaw, tokenRaw] = (authHeader ?? "").split(/\s+/, 2);
  const scheme = schemeRaw ? schemeRaw : null;
  const token = tokenRaw ? tokenRaw.trim() : "";
  const isBearer = scheme?.toLowerCase() === "bearer";
  const hasToken = isBearer && token.length > 0;
  const isJwt = hasToken && token.split(".").length === 3;

  const claims = isJwt ? parseJwtClaims(token) : null;
  const expectedProjectRef = extractProjectRefFromSupabaseUrl(supabaseUrl);
  const tokenProjectRef = claims
    ? typeof claims.ref === "string"
      ? claims.ref
      : extractProjectRefFromIssuer(claims.iss)
    : null;

  const exp = claims ? parseNumericClaim(claims.exp) : undefined;
  const tokenExpired = exp ? exp <= Math.floor(Date.now() / 1000) : null;

  return {
    has_authorization_header: hasHeader,
    authorization_scheme: scheme,
    token_prefix: hasToken ? token.slice(0, 12) : null,
    token_kind: !hasHeader ? "missing" : isJwt ? "jwt" : "non_jwt",
    claims: claims ? toPublicClaims(claims) : null,
    expected_project_ref: expectedProjectRef,
    token_project_ref: tokenProjectRef,
    project_ref_matches:
      expectedProjectRef && tokenProjectRef ? expectedProjectRef === tokenProjectRef : null,
    token_expired: tokenExpired,
  };
}

export function logAuthDebug(functionName: string, snapshot: AuthDebugSnapshot): void {
  console.log(`[${functionName}] auth_debug`, JSON.stringify(snapshot));
}
