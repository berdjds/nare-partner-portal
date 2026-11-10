"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { useT } from "@/lib/i18n/react";
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
    setLoading(true);
    setError(null);
    const result = await signIn("credentials", {
      email,
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
      <aside className="flex flex-col gap-4 bg-gradient-to-br from-primary to-gradient-end px-6 py-8 text-primary-foreground lg:justify-center lg:gap-10 lg:px-16">
        <h1 className="max-w-md text-2xl font-semibold tracking-tight lg:text-4xl">
          {t("login.headline")}
        </h1>
        <ul className="max-w-md space-y-2 text-base leading-relaxed text-primary-foreground/90 lg:space-y-4 lg:text-lg">
          {(["login.bullet1", "login.bullet2", "login.bullet3"] as const).map((k) => (
            <li key={k} className="flex items-start gap-3">
              <Check className="mt-1 h-5 w-5 shrink-0" aria-hidden="true" />
              <span>{t(k)}</span>
            </li>
          ))}
        </ul>
      </aside>

      <div className="flex flex-col items-center justify-start bg-background p-4 pt-12 lg:justify-center lg:pt-4">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <CardTitle className="text-xl">{t("login.title")}</CardTitle>
            <CardDescription>
              {t("login.subtitle")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
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
                  required
                />
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
                    required
                    className="pr-10"
                  />
                  <button
                    type="button"
                    aria-pressed={showPassword}
                    aria-label={showPassword ? t("login.hidePassword") : t("login.showPassword")}
                    onClick={() => setShowPassword((visible) => !visible)}
                    className="absolute inset-y-0 right-0 flex h-10 w-10 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Eye className="h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
                {capsLockOn && (
                  <p className="text-sm text-muted-foreground">{t("login.capsLock")}</p>
                )}
              </div>
              {error && (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={loading}>
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
