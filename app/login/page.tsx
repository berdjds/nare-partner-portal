"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { useT } from "@/lib/i18n/react";
import { validateLogin } from "@/lib/login-validation";
import { badgeStatusTextStyles } from "@/components/ui/badge";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { FRIENDLY_CREDENTIALS_ERROR, friendlyLoginError } from "@/lib/login-errors";
import { PublicHeader } from "@/components/public/PublicHeader";
import { PublicFooter } from "@/components/public/PublicFooter";
import { FORGOT_ACCESS } from "@/lib/portal-content";

function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const t = useT();

  const callbackUrl = searchParams.get("callbackUrl") || "/";

  function handlePasswordKeyUp(e: React.KeyboardEvent<HTMLInputElement>) {
    setCapsLockOn(e.getModifierState("CapsLock"));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Format-only checks, done in the browser: they say nothing about whether an account exists.
    const v = validateLogin(email, password);
    const found = { email: v.email && t(v.email), password: v.password && t(v.password) };
    setFieldErrors(found);
    if (found.email || found.password) {
      setError(null);
      document.getElementById(found.email ? "email" : "password")?.focus();
      return;
    }
    setLoading(true);
    setError(null);
    const result = await signIn("credentials", {
      email: email.trim(),
      password,
      redirect: false,
      callbackUrl,
    });
    setLoading(false);

    if (result?.ok) {
      router.push(callbackUrl);
      router.refresh();
    } else {
      // One identical message for every failure (lib/login-errors.ts): an
      // unknown email and a wrong password must stay indistinguishable.
      // One identical, localised message for every failure (unknown email and wrong password stay
      // indistinguishable); the catalogue text is the same sentence friendlyLoginError() returns in English.
      const english = friendlyLoginError(result?.error);
      const message = english === FRIENDLY_CREDENTIALS_ERROR ? t("login.error") : english;
      setError(message);
      toast(message, "error");
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <PublicHeader active="login" />
      <div className="grid flex-1 grid-rows-[auto_1fr] lg:grid-cols-2 lg:grid-rows-1">
      <aside className="relative flex flex-col gap-4 overflow-hidden bg-gradient-to-br from-plum via-plum to-brand px-6 py-8 text-white lg:justify-center lg:gap-10 lg:px-16">
        <span aria-hidden="true" className="pointer-events-none absolute -bottom-24 -end-20 h-72 w-72 rounded-full border-[28px] border-white/10" />
        <span aria-hidden="true" className="pointer-events-none absolute -top-16 start-1/3 hidden h-40 w-40 rounded-full bg-warm/20 blur-2xl lg:block" />
        <h1 className="font-display relative max-w-md text-3xl leading-tight lg:text-5xl">
          {t("login.headline")}
        </h1>
        <ul className="max-w-md space-y-2 relative text-base leading-relaxed text-white/90 lg:space-y-4 lg:text-lg">
          {(["login.bullet1", "login.bullet2", "login.bullet3"] as const).map((k) => (
            <li key={k} className="flex items-start gap-3">
              <span className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-warm text-plum"><Check className="h-3.5 w-3.5" aria-hidden="true" /></span>
              <span>{t(k)}</span>
            </li>
          ))}
        </ul>
      </aside>

      <div className="flex flex-col items-center justify-start bg-background p-4 pt-10 lg:justify-center lg:pt-4">
        <Card className="w-full max-w-md shadow-[var(--shadow-lift)]">
          <CardHeader className="p-8 pb-4 text-center">
            <CardTitle className="text-3xl">{t("login.title")}</CardTitle>
            <CardDescription>
              {t("login.subtitle")}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-8 pt-2">
            <form onSubmit={handleSubmit} noValidate className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">{t("login.email")}</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t("login.emailPlaceholder")}
                  aria-invalid={fieldErrors.email ? true : undefined}
                  aria-describedby={fieldErrors.email ? "email-error" : undefined}
                />
                {fieldErrors.email && (
                  <p id="email-error" className={`text-sm font-medium ${badgeStatusTextStyles.danger}`}>{fieldErrors.email}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">{t("login.password")}</Label>
                <div className="relative">
                  <Input
                    id="password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyUp={handlePasswordKeyUp}
                    aria-invalid={fieldErrors.password ? true : undefined}
                    aria-describedby={fieldErrors.password ? "password-error" : undefined}
                    className="pe-10"
                  />
                  <button
                    type="button"
                    aria-pressed={showPassword}
                    aria-label={showPassword ? t("login.hidePassword") : t("login.showPassword")}
                    onClick={() => setShowPassword((visible) => !visible)}
                    className="absolute inset-y-0 end-0 flex h-10 w-10 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Eye className="h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
                {fieldErrors.password && (
                  <p id="password-error" className={`text-sm font-medium ${badgeStatusTextStyles.danger}`}>{fieldErrors.password}</p>
                )}
                {capsLockOn && (
                  <p className="text-sm text-muted-foreground">{t("login.capsLock")}</p>
                )}
              </div>
              {error && (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" size="lg" className="w-full" disabled={loading}>
                {loading ? t("login.submitting") : t("login.submit")}
              </Button>
            </form>
            <p className="mt-4 text-center text-sm">
              <Link
                href={FORGOT_ACCESS.href}
                className="text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                {t("login.forgot")}
              </Link>
            </p>
          </CardContent>
        </Card>
        <Link
          href="/partners/apply"
          className="mt-4 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          {t("nav.apply")}
        </Link>
      </div>
      </div>
      <PublicFooter />
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
