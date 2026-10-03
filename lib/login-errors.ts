/**
 * Maps next-auth signIn error codes to user-facing login messages.
 *
 * Every credential failure resolves to ONE identical message: an unknown
 * email and a wrong password must be indistinguishable, otherwise the form
 * could be used to enumerate which accounts exist. The same fallback also
 * covers unexpected codes so a future next-auth failure mode can never leak
 * internals into the UI.
 */

export const FRIENDLY_CREDENTIALS_ERROR = "Email or password is incorrect.";

const LOGIN_ERROR_MESSAGES: Record<string, string> = {
  CredentialsSignin: FRIENDLY_CREDENTIALS_ERROR,
};

export function friendlyLoginError(error: string | null | undefined): string {
  if (!error) {
    return FRIENDLY_CREDENTIALS_ERROR;
  }
  return LOGIN_ERROR_MESSAGES[error] ?? FRIENDLY_CREDENTIALS_ERROR;
}
