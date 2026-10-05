import type { WhatsAppState } from "@/hooks/useSocket";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

export interface AccountCardData {
  key: string;
  displayName: string;
  enabled: boolean;
  purpose: string;
  publicNumber: string | null;
  verifiedNumber: string | null;
  // Already merged by the parent (socket state wins over the HTTP fallback),
  // so the panel never decides which source to show.
  state: WhatsAppState | null;
}

export interface AccountsPanelProps {
  accounts: AccountCardData[];
  // The browser↔server socket link, shown separately from the per-account
  // WhatsApp states: a ready account is invisible when the live channel dies.
  browserLink: { connected: boolean; unauthorized: boolean };
  busyAccount?: string | null;
  onAction: (accountKey: string, action: "connect" | "reconnect" | "disconnect") => void;
  onToggleEnabled: (accountKey: string, enabled: boolean) => void;
}

// Presentational by design (no hooks, no Radix, no fetching): the parent owns
// all data, and tests render this with react-dom/server.
export default function AccountsPanel({ accounts, browserLink, busyAccount, onAction, onToggleEnabled }: AccountsPanelProps) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Server link:{" "}
        <Badge variant={browserLink.connected ? "default" : "destructive"}>
          {browserLink.unauthorized ? "session expired" : browserLink.connected ? "connected" : "offline"}
        </Badge>
      </p>

      {accounts.map((account) => {
        const busy = busyAccount === account.key;
        const state = account.state;
        return (
          <Card key={account.key}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {account.displayName}
                <Badge variant="secondary">{account.purpose}</Badge>
              </CardTitle>
              <CardDescription>Account key: {account.key}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1 text-sm">
                <p>Verified number: {account.verifiedNumber ? `+${account.verifiedNumber}` : "Not paired"}</p>
                {account.publicNumber && <p>Public number: +{account.publicNumber}</p>}
                <p>
                  WhatsApp state:{" "}
                  <Badge variant={state?.state === "ready" ? "default" : "outline"}>
                    {/* A disabled account has no running client; its lazy
                        runtime would otherwise report "initializing" forever. */}
                    {account.enabled ? state?.state || state?.info || "unknown" : "Disabled"}
                  </Badge>
                </p>
              </div>

              {/* No switch primitive exists in the UI kit; reuse the raw
                  checkbox idiom already used for the user "Active" toggle. */}
              <div className="flex items-center gap-2">
                <input
                  id={`enabled-${account.key}`}
                  type="checkbox"
                  checked={account.enabled}
                  disabled={busy}
                  onChange={(e) => onToggleEnabled(account.key, e.target.checked)}
                />
                <Label htmlFor={`enabled-${account.key}`}>Enabled</Label>
              </div>

              <div className="flex gap-2">
                <Button onClick={() => onAction(account.key, "connect")} disabled={busy}>
                  Connect
                </Button>
                <Button onClick={() => onAction(account.key, "reconnect")} disabled={busy}>
                  Reconnect
                </Button>
                <Button variant="destructive" onClick={() => onAction(account.key, "disconnect")} disabled={busy}>
                  Disconnect
                </Button>
              </div>

              {state?.qrSvg ? (
                <div className="rounded-lg border bg-white p-4">
                  <p className="mb-2 text-sm font-medium">Scan this QR code with WhatsApp on your phone:</p>
                  {/* Data-URI img instead of raw HTML: the SVG comes from the
                      WhatsApp runtime, and injecting it as markup would hand
                      that channel a script-execution path (W7a). */}
                  <img
                    src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(state.qrSvg)}`}
                    alt={`WhatsApp pairing QR code for ${account.displayName}`}
                    className="inline-block"
                  />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{state?.info || "Waiting for WhatsApp state..."}</p>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
