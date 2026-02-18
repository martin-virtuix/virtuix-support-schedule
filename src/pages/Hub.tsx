import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import omniLogo from "@/assets/omniarena-logo.png";

const ALLOWED_DOMAIN = "@virtuix.com";

function isAllowedEmail(email?: string | null): boolean {
  return !!email && email.toLowerCase().endsWith(ALLOWED_DOMAIN);
}

export default function Hub() {
  const [session, setSession] = useState<Session | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function loadSession() {
      const { data, error } = await supabase.auth.getSession();

      if (!mounted) {
        return;
      }

      if (error) {
        setStatus(error.message);
      }

      setSession(data.session ?? null);
      setLoadingSession(false);
    }

    loadSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession ?? null);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session) {
      return;
    }

    const userEmail = session.user.email;
    if (isAllowedEmail(userEmail)) {
      return;
    }

    setStatus("Access is limited to @virtuix.com accounts.");
    void supabase.auth.signOut();
  }, [session]);

  const userEmail = session?.user.email ?? null;
  const authorized = useMemo(() => isAllowedEmail(userEmail), [userEmail]);

  async function handleSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalized = email.trim().toLowerCase();
    if (!isAllowedEmail(normalized)) {
      setStatus("Use your @virtuix.com email address.");
      return;
    }

    setSubmitting(true);
    setStatus(null);

    const redirectTo = `${window.location.origin}/hub`;
    const { error } = await supabase.auth.signInWithOtp({
      email: normalized,
      options: { emailRedirectTo: redirectTo },
    });

    if (error) {
      setStatus(error.message);
    } else {
      setStatus("Check your email for the sign-in link.");
    }

    setSubmitting(false);
  }

  async function handleSignOut() {
    const { error } = await supabase.auth.signOut();
    if (error) {
      setStatus(error.message);
      return;
    }
    setStatus("Signed out.");
  }

  if (loadingSession) {
    return (
      <main className="min-h-screen bg-background">
        <div className="container max-w-3xl py-12 px-4">
          <p className="text-sm text-muted-foreground">Loading Support Hub...</p>
        </div>
      </main>
    );
  }

  if (!authorized) {
    return (
      <main className="min-h-screen bg-background">
        <div className="container max-w-3xl py-12 px-4 space-y-8">
          <header className="text-center space-y-3">
            <h1 className="text-3xl font-bold">Support Hub</h1>
            <img src={omniLogo} alt="Omni Arena" className="h-8 mx-auto opacity-80" />
            <p className="text-sm text-muted-foreground">
              Internal access only for Virtuix support operations.
            </p>
          </header>

          <section className="border rounded-lg p-6 space-y-4">
            <h2 className="text-lg font-semibold">Sign in</h2>
            <p className="text-sm text-muted-foreground">
              Enter your company email to receive a secure sign-in link.
            </p>
            <form className="space-y-3" onSubmit={handleSignIn}>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@virtuix.com"
                required
              />
              <Button type="submit" disabled={submitting}>
                {submitting ? "Sending link..." : "Send sign-in link"}
              </Button>
            </form>
            {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background">
      <div className="container max-w-6xl py-10 px-4 space-y-8">
        <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-3xl font-bold">Support Hub</h1>
            <p className="text-sm text-muted-foreground">
              Authenticated as {userEmail}. Internal workflows will live here.
            </p>
          </div>
          <Button variant="outline" onClick={handleSignOut}>
            Sign out
          </Button>
        </header>

        <section className="grid gap-4 md:grid-cols-2">
          <article className="border rounded-lg p-5">
            <h2 className="text-lg font-semibold">Zendesk Sync</h2>
            <p className="text-sm text-muted-foreground mt-2">
              Ticket ingestion and status sync module placeholder.
            </p>
          </article>
          <article className="border rounded-lg p-5">
            <h2 className="text-lg font-semibold">AI Ticket Tools</h2>
            <p className="text-sm text-muted-foreground mt-2">
              Summary and open-ticket digest module placeholder.
            </p>
          </article>
        </section>
      </div>
    </main>
  );
}
