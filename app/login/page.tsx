"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { friendlyLoginError } from "@/lib/login-errors";
import { BrandMark } from "@/components/app/BrandMark";
import { FORGOT_ACCESS, LOGIN_PANEL, PRODUCT_NAME } from "@/lib/portal-content";

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
      const message = friendlyLoginError(result?.error);
      setError(message);
      toast(message, "error");
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Brand panel: second column on large screens, hidden on phones. Text
          wordmark until the real logo asset ships; no image file exists yet. */}
      <aside className="hidden bg-gradient-to-br from-primary to-brand text-primary-foreground lg:flex lg:flex-col lg:justify-center lg:gap-10 lg:px-16">
        <span className="text-2xl font-bold uppercase tracking-[0.2em]">
          {PRODUCT_NAME}
        </span>
        <h1 className="max-w-md text-4xl font-semibold tracking-tight">
          {LOGIN_PANEL.headline}
        </h1>
        <ul className="max-w-md space-y-4 text-lg leading-relaxed text-primary-foreground/90">
          {LOGIN_PANEL.bullets.map((bullet) => (
            <li key={bullet} className="flex items-start gap-3">
              <Check className="mt-1 h-5 w-5 shrink-0" aria-hidden="true" />
              <span>{bullet}</span>
            </li>
          ))}
        </ul>
      </aside>

      <div className="flex flex-col items-center justify-center bg-background p-4">
        {/* Wordmark for phones, where the brand panel is hidden. */}
        <span className="mb-6 text-lg font-bold uppercase tracking-[0.2em] text-primary lg:hidden">
          {PRODUCT_NAME}
        </span>
        <div className="mb-6">
          <BrandMark />
        </div>
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Sign in</CardTitle>
            <CardDescription>
              Use the account provided by the Nare team.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
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
                    aria-label={showPassword ? "Hide password" : "Show password"}
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
                {capsLockOn && (
                  <p className="text-sm text-muted-foreground">Caps Lock is on.</p>
                )}
              </div>
              {error && (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Signing in..." : "Sign in"}
              </Button>
            </form>
            <p className="mt-4 text-center text-sm">
              <a
                href={`mailto:${FORGOT_ACCESS.mailto}`}
                className="text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                {FORGOT_ACCESS.text}
              </a>
            </p>
          </CardContent>
        </Card>
        <Link
          href="/"
          className="mt-6 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          Back to home
        </Link>
        <p className="mt-2 text-xs text-muted-foreground">
          Developed by <span className="font-medium text-foreground/70">Hayk FZC</span>
        </p>
      </div>
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
