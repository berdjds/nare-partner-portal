"use client";

/**
 * Self-service password reset, step 1 (W6a) — the /forgot-password form.
 *
 * Posts to POST /api/auth/password-reset/request, which always answers
 * 200 {message} whether or not the email belongs to an account, so the
 * success view here is deliberately identical for every submission
 * (anti-enumeration). Non-200 responses mean the request itself failed
 * (per-IP limit, server or network error) and are shown verbatim from the
 * body's `error` field, falling back to the generic unavailable copy.
 *
 * The honeypot field name "website" mirrors PASSWORD_RESET_HONEYPOT_FIELD in
 * lib/security/limits.ts, which is a node-only module (node:crypto) and
 * cannot be imported from a client component; tests assert they match.
 */

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FORGOT_PAGE } from "@/lib/portal-content";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, website }),
      });
      if (res.ok) {
        setSent(true);
        return;
      }
      const body = await res.json().catch(() => null);
      setError(body && typeof body.error === "string" ? body.error : FORGOT_PAGE.unavailable);
    } catch {
      setError(FORGOT_PAGE.unavailable);
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-xl">{FORGOT_PAGE.successTitle}</CardTitle>
          <CardDescription>{FORGOT_PAGE.successBody}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link
            href="/login"
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            {FORGOT_PAGE.backToSignIn}
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex w-full max-w-sm flex-col items-center">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-xl">{FORGOT_PAGE.headline}</CardTitle>
          <CardDescription>{FORGOT_PAGE.intro}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} aria-busy={submitting} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">{FORGOT_PAGE.emailLabel}</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            {/* Honeypot: mirrors PASSWORD_RESET_HONEYPOT_FIELD
                (lib/security/limits.ts, node-only). Invisible to humans and
                skipped by keyboard; bots that fill it trip the endpoint. */}
            <div className="hidden" aria-hidden="true">
              <Label htmlFor="website">Website</Label>
              <Input
                id="website"
                name="website"
                type="text"
                tabIndex={-1}
                autoComplete="off"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
              />
            </div>
            <div aria-live="polite">
              {error && (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {error}
                </p>
              )}
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? FORGOT_PAGE.submittingLabel : FORGOT_PAGE.submitLabel}
            </Button>
          </form>
        </CardContent>
      </Card>
      <Link
        href="/login"
        className="mt-4 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
      >
        {FORGOT_PAGE.backToSignIn}
      </Link>
    </div>
  );
}
