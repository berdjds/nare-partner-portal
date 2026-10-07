"use client";

/**
 * Self-service password reset, step 2 (W6a) — the /reset-password form,
 * reached from the emailed link (?token=...).
 *
 * Posts to POST /api/auth/password-reset/confirm. A 400 response carries
 * either a password-policy message (the token stays usable, so the user can
 * fix the password and retry with the same link) or the generic
 * invalid/expired message; both are shown verbatim from the body's `error`
 * field. Length and mismatch are pre-checked client-side only to save a
 * round trip — the server re-checks the full policy
 * (lib/security/password-policy.ts).
 */

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RESET_PAGE } from "@/lib/portal-content";

export function ResetPasswordForm() {
  const token = useSearchParams().get("token");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [newPasswordError, setNewPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNewPasswordError(null);
    setConfirmError(null);
    setFormError(null);

    // Fast feedback only; the server re-checks the full policy and the token.
    // Each error is tied to the field it concerns.
    if (password.length < 12) {
      setNewPasswordError(RESET_PAGE.requirements);
      return;
    }
    if (password !== confirmPassword) {
      setConfirmError(RESET_PAGE.mismatchError);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (res.ok) {
        setDone(true);
        return;
      }
      const body = await res.json().catch(() => null);
      setFormError(body && typeof body.error === "string" ? body.error : RESET_PAGE.unavailable);
    } catch {
      setFormError(RESET_PAGE.unavailable);
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-xl">{RESET_PAGE.headline}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p role="alert" className="text-sm font-medium text-destructive">
            {RESET_PAGE.invalidLink}
          </p>
          <Link href="/forgot-password" className="text-primary underline underline-offset-4">
            {RESET_PAGE.requestNewLink}
          </Link>
        </CardContent>
      </Card>
    );
  }

  if (done) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-xl">{RESET_PAGE.successTitle}</CardTitle>
          <CardDescription>{RESET_PAGE.successBody}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/login" className="text-primary underline underline-offset-4">
            {RESET_PAGE.signInLabel}
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="text-center">
        <CardTitle className="text-xl">{RESET_PAGE.headline}</CardTitle>
        <CardDescription>{RESET_PAGE.intro}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} aria-busy={submitting} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-password">{RESET_PAGE.newLabel}</Label>
            <div className="relative">
              <Input
                id="new-password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="pr-10"
                aria-invalid={newPasswordError ? "true" : undefined}
                aria-describedby={
                  newPasswordError
                    ? "password-requirements new-password-error"
                    : "password-requirements"
                }
              />
              <button
                type="button"
                aria-pressed={showPassword}
                aria-label={showPassword ? RESET_PAGE.hideLabel : RESET_PAGE.showLabel}
                onClick={() => setShowPassword((visible) => !visible)}
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground"
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
            <p id="password-requirements" className="text-sm text-muted-foreground">
              {RESET_PAGE.requirements}
            </p>
            {newPasswordError && (
              <p id="new-password-error" role="alert" className="text-sm font-medium text-destructive">
                {newPasswordError}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-password">{RESET_PAGE.confirmLabel}</Label>
            <Input
              id="confirm-password"
              name="confirmPassword"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              aria-invalid={confirmError ? "true" : undefined}
              aria-describedby={confirmError ? "confirm-password-error" : undefined}
            />
            {confirmError && (
              <p id="confirm-password-error" role="alert" className="text-sm font-medium text-destructive">
                {confirmError}
              </p>
            )}
          </div>
          <div aria-live="polite">
            {formError && (
              <p role="alert" className="text-sm font-medium text-destructive">
                {formError}
              </p>
            )}
          </div>
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? RESET_PAGE.submittingLabel : RESET_PAGE.submitLabel}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
