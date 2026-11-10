/**
 * Browser-side sign-in checks: format only. They never touch the server and say nothing about
 * whether an account exists, so the identical-failure rule for credentials is unaffected.
 */
export type LoginFieldError = "login.err.emailRequired" | "login.err.emailInvalid" | "login.err.passwordRequired";

export function validateLogin(email: string, password: string): { email?: LoginFieldError; password?: LoginFieldError } {
  const out: { email?: LoginFieldError; password?: LoginFieldError } = {};
  const e = email.trim();
  if (!e) out.email = "login.err.emailRequired";
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) out.email = "login.err.emailInvalid";
  if (!password) out.password = "login.err.passwordRequired";
  return out;
}
