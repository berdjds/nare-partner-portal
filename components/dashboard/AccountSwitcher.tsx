import { Button } from "@/components/ui/button";
import { DEFAULT_ACCOUNT_KEY } from "@/hooks/useSocket";

export interface SwitcherAccount {
  key: string;
  displayName: string;
}

/**
 * W3: the dashboard opens on Marhaba (the pre-W3 account) whenever the user
 * may view it, otherwise on their first permitted account.
 */
export function pickDefaultAccountKey(accounts: SwitcherAccount[]): string {
  return accounts.some((a) => a.key === DEFAULT_ACCOUNT_KEY)
    ? DEFAULT_ACCOUNT_KEY
    : accounts[0]?.key ?? DEFAULT_ACCOUNT_KEY;
}

export interface AccountSwitcherProps {
  accounts: SwitcherAccount[];
  selected: string;
  onSelect: (accountKey: string) => void;
}

/**
 * W3: per-account switcher for the chat dashboard header.
 * Presentational on purpose (no hooks, no portals) so tests can render it
 * with react-dom/server. With a single visible account there is nothing to
 * switch, so it renders null.
 */
export default function AccountSwitcher({ accounts, selected, onSelect }: AccountSwitcherProps) {
  if (accounts.length < 2) return null;
  return (
    <div className="flex items-center gap-1">
      {accounts.map((account) => (
        <Button
          key={account.key}
          variant={account.key === selected ? "default" : "outline"}
          size="sm"
          onClick={() => onSelect(account.key)}
        >
          {account.displayName}
        </Button>
      ))}
    </div>
  );
}
