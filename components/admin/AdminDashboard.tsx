"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSocket, resolveWhatsAppDisplayState, DEFAULT_ACCOUNT_KEY, type WhatsAppState } from "@/hooks/useSocket";
import { useToast } from "@/components/ui/toast";
import UserPermissionsDialog from "@/components/admin/UserPermissionsDialog";
import AccountsPanel, { type AccountCardData } from "@/components/admin/AccountsPanel";

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  active: boolean;
  phone: string | null;
  createdAt: string;
}

interface Log {
  id: string;
  action: string;
  details: string | null;
  createdAt: string;
  user: { email: string; name: string } | null;
}

// Row shape of GET /api/whatsapp/accounts: only accounts the caller may
// administer, each with the full live state (qrSvg included) attached.
interface WhatsAppAccountRow {
  key: string;
  displayName: string;
  enabled: boolean;
  purpose: string;
  publicNumber: string | null;
  verifiedNumber: string | null;
  state: WhatsAppState | null;
}

export default function AdminDashboard({ canAdminWhatsApp, currentUserId }: { canAdminWhatsApp: boolean; currentUserId: string }) {
  const { connected, unauthorized, whatsAppStates, disconnectSocket } = useSocket();
  const { toast } = useToast();

  const [users, setUsers] = useState<User[]>([]);
  const [logs, setLogs] = useState<Log[]>([]);
  const [buildInfo, setBuildInfo] = useState<{ version?: string; startedAt?: string } | null>(null);
  const [permissionsUserId, setPermissionsUserId] = useState<string | null>(null);

  const [accounts, setAccounts] = useState<WhatsAppAccountRow[]>([]);
  const [accountsUnauthorized, setAccountsUnauthorized] = useState(false);
  // HTTP-fallback states per account: the socket is live but silent until the
  // first event, so cards resolve against these instead of showing "unknown".
  const [httpStates, setHttpStates] = useState<Record<string, WhatsAppState>>({});
  const [busyAccount, setBusyAccount] = useState<string | null>(null);

  const [newUser, setNewUser] = useState({
    email: "",
    name: "",
    password: "",
    role: "USER" as "ADMIN" | "USER" | "ADVISOR" | "VALIDATOR",
    phone: "",
  });
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [editRole, setEditRole] = useState("USER");
  const [editActive, setEditActive] = useState(true);
  const [editPhone, setEditPhone] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);

  async function fetchUsers() {
    try {
      const res = await axios.get("/api/users");
      setUsers(res.data);
    } catch {
      toast("Failed to load users", "error");
    }
  }

  async function fetchLogs() {
    try {
      const res = await axios.get("/api/logs?take=200");
      setLogs(res.data);
    } catch {
      toast("Failed to load logs", "error");
    }
  }

  async function fetchAccounts() {
    try {
      const res = await axios.get("/api/whatsapp/accounts");
      const rows = res.data as WhatsAppAccountRow[];
      setAccounts(rows);
      setAccountsUnauthorized(false);
      // Seed the HTTP fallback map so each card shows the last server-reported
      // state until the socket delivers a fresher one.
      setHttpStates((prev) => {
        const next = { ...prev };
        for (const row of rows) {
          if (row.state) next[row.key] = row.state;
        }
        return next;
      });
    } catch (err: any) {
      // The API answers 401 when the caller administers no account at all;
      // the tab then shows the same no-permission notice the old connection
      // tab showed without whatsapp.admin.
      if (err?.response?.status === 401) {
        setAccounts([]);
        setAccountsUnauthorized(true);
      } else {
        toast("Failed to load WhatsApp accounts", "error");
      }
    }
  }

  useEffect(() => {
    fetchUsers();
    fetchLogs();
    fetchAccounts();
    // The build indicator reads version/startedAt from the full status payload,
    // which only whatsapp.admin holders receive — skip the call otherwise.
    if (canAdminWhatsApp) {
      axios
        .get("/api/whatsapp/status")
        .then((res) => {
          setBuildInfo({ version: res.data.version, startedAt: res.data.startedAt });
          // The default account's HTTP fallback state rides on the same call.
          setHttpStates((prev) => ({ ...prev, [DEFAULT_ACCOUNT_KEY]: res.data }));
        })
        .catch(() => null);
    }
  }, []);

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    try {
      await axios.post("/api/users", { ...newUser, phone: newUser.phone.trim() === "" ? null : newUser.phone.trim() });
      toast("User created", "success");
      setNewUser({ email: "", name: "", password: "", role: "USER", phone: "" });
      fetchUsers();
      fetchLogs();
    } catch (err: any) {
      toast(err?.response?.data?.error || "Failed to create user", "error");
    }
  }

  async function handleUpdateUser(e: React.FormEvent) {
    e.preventDefault();
    if (!editingUser) return;
    try {
      await axios.patch("/api/users", {
        id: editingUser.id,
        role: editRole,
        active: editActive,
        phone: editPhone.trim() === "" ? null : editPhone.trim(),
      });
      toast("User updated", "success");
      setEditingUser(null);
      fetchUsers();
      fetchLogs();
    } catch (err: any) {
      toast(err?.response?.data?.error || "Failed to update user", "error");
    }
  }

  async function handleDeleteUser(id: string) {
    if (!confirm("Are you sure you want to delete this user?")) return;
    try {
      await axios.delete(`/api/users?id=${id}`);
      toast("User deleted", "success");
      fetchUsers();
      fetchLogs();
    } catch (err: any) {
      toast(err?.response?.data?.error || "Failed to delete user", "error");
    }
  }

  async function handleRevokeSessions(id: string, email: string) {
    if (!confirm(`Revoke all sessions of ${email}? Every device is signed out on its next request.`)) return;
    try {
      await axios.post(`/api/users/${id}/revoke-sessions`);
      toast("Sessions revoked", "success");
      fetchLogs();
    } catch (err: any) {
      toast(err?.response?.data?.error || "Failed to revoke sessions", "error");
    }
  }

  async function handleSignOutEverywhere() {
    try {
      await axios.post("/api/auth/sign-out-everywhere");
    } catch {
      // Best effort: the local sign-out below still ends this session.
    }
    disconnectSocket();
    signOut({ callbackUrl: "/login" });
  }

  async function handleAccountAction(accountKey: string, action: "connect" | "reconnect" | "disconnect") {
    setBusyAccount(accountKey);
    try {
      // connect/reconnect are async server-side; the QR and new states arrive
      // over the socket, the refreshed list only carries the immediate state.
      await axios.post("/api/whatsapp/accounts", { action, account: accountKey });
      toast(
        action === "connect" ? "Connecting WhatsApp" : action === "reconnect" ? "Reconnecting WhatsApp" : "Disconnected WhatsApp",
        "success"
      );
      fetchAccounts();
    } catch (err: any) {
      toast(err?.response?.data?.error || "Action failed", "error");
    } finally {
      setBusyAccount(null);
    }
  }

  async function handleToggleEnabled(accountKey: string, enabled: boolean) {
    setBusyAccount(accountKey);
    try {
      await axios.post("/api/whatsapp/accounts", { action: "configure", account: accountKey, enabled });
      toast(enabled ? "Account enabled" : "Account disabled", "success");
      fetchAccounts();
    } catch (err: any) {
      toast(err?.response?.data?.error || "Failed to update account", "error");
    } finally {
      setBusyAccount(null);
    }
  }

  const accountCards: AccountCardData[] = accounts.map((account) => ({
    key: account.key,
    displayName: account.displayName,
    enabled: account.enabled,
    purpose: account.purpose,
    publicNumber: account.publicNumber,
    verifiedNumber: account.verifiedNumber,
    state: resolveWhatsAppDisplayState(whatsAppStates[account.key], httpStates[account.key]),
  }));

  return (
    <div className="min-h-screen bg-muted/40 p-4">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Admin Panel</h1>
          <p className="text-sm text-muted-foreground">Manage WhatsApp connection, users, and logs.</p>
          {buildInfo?.version && (
            <p className="mt-1 text-xs text-muted-foreground">
              Build: <Badge variant="outline">v{buildInfo.version}</Badge>{" "}
              {buildInfo.startedAt && (
                <span>· server up since {new Date(buildInfo.startedAt).toLocaleString()}</span>
              )}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => (window.location.href = "/dashboard")}>
            Dashboard
          </Button>
          <Button variant="outline" onClick={() => (window.location.href = "/calculator")}>
            Calculator
          </Button>
          <Button variant="outline" onClick={() => (window.location.href = "/travel")}>
            Travel
          </Button>
          <Button variant="outline" onClick={() => (window.location.href = "/admin/permissions")}>
            Permissions report
          </Button>
          <Button variant="outline" onClick={handleSignOutEverywhere}>
            Sign out everywhere
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              disconnectSocket();
              signOut({ callbackUrl: "/login" });
            }}
          >
            Sign out
          </Button>
        </div>
      </header>

      <Tabs defaultValue="accounts" className="space-y-4">
        <TabsList>
          <TabsTrigger value="accounts">Accounts</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="accounts">
          {/* Hidden without any account admin permission: the server already
              withholds the account list, states, QR and actions (401). */}
          {accountsUnauthorized ? (
            <Card>
              <CardHeader>
                <CardTitle>WhatsApp Accounts</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  You do not have the WhatsApp administration permission. Connection details and actions are
                  available to whatsapp.admin holders only.
                </p>
              </CardContent>
            </Card>
          ) : (
            <AccountsPanel
              accounts={accountCards}
              browserLink={{ connected, unauthorized }}
              busyAccount={busyAccount}
              onAction={handleAccountAction}
              onToggleEnabled={handleToggleEnabled}
            />
          )}
        </TabsContent>

        <TabsContent value="users">
          <Card>
            <CardHeader>
              <CardTitle>Users</CardTitle>
              <CardDescription>Create and manage dashboard users.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <form onSubmit={handleCreateUser} className="grid gap-3 sm:grid-cols-6">
                <Input placeholder="Name" value={newUser.name} onChange={(e) => setNewUser({ ...newUser, name: e.target.value })} required />
                <Input placeholder="Email" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} required type="email" />
                <Input placeholder="Password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} required type="password" />
                <Input
                  placeholder="Phone (WhatsApp, optional)"
                  value={newUser.phone}
                  onChange={(e) => setNewUser({ ...newUser, phone: e.target.value })}
                />
                <Select value={newUser.role} onValueChange={(v) => setNewUser({ ...newUser, role: v as typeof newUser.role })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USER">User</SelectItem>
                    <SelectItem value="ADMIN">Admin</SelectItem>
                    <SelectItem value="ADVISOR">Advisor</SelectItem>
                    <SelectItem value="VALIDATOR">Validator</SelectItem>
                  </SelectContent>
                </Select>
                <Button type="submit">Create user</Button>
              </form>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b text-left">
                    <tr>
                      <th className="pb-2 font-medium">Name</th>
                      <th className="pb-2 font-medium">Email</th>
                      <th className="pb-2 font-medium">Role</th>
                      <th className="pb-2 font-medium">Phone</th>
                      <th className="pb-2 font-medium">Status</th>
                      <th className="pb-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {users.map((user) => (
                      <tr key={user.id}>
                        <td className="py-2">{user.name}</td>
                        <td className="py-2">{user.email}</td>
                        <td className="py-2">{user.role}</td>
                        <td className="py-2">{user.phone ? `+${user.phone}` : "—"}</td>
                        <td className="py-2">{user.active ? "Active" : "Inactive"}</td>
                        <td className="py-2">
                          <div className="flex gap-2">
                            <Dialog open={dialogOpen && editingUser?.id === user.id} onOpenChange={(open) => { if (!open) setEditingUser(null); setDialogOpen(open); }}>
                              <DialogTrigger asChild>
                                <Button size="sm" variant="outline" onClick={() => { setEditingUser(user); setEditRole(user.role); setEditActive(user.active); setEditPhone(user.phone ?? ""); setDialogOpen(true); }}>
                                  Edit
                                </Button>
                              </DialogTrigger>
                              <DialogContent>
                                <DialogHeader>
                                  <DialogTitle>Edit user</DialogTitle>
                                  <DialogDescription>Update role or deactivate {user.email}.</DialogDescription>
                                </DialogHeader>
                                <form onSubmit={handleUpdateUser} className="space-y-4">
                                  <div>
                                    <Label>Role</Label>
                                    <Select value={editRole} onValueChange={setEditRole}>
                                      <SelectTrigger>
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="USER">User</SelectItem>
                                        <SelectItem value="ADMIN">Admin</SelectItem>
                                        <SelectItem value="ADVISOR">Advisor</SelectItem>
                                        <SelectItem value="VALIDATOR">Validator</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div>
                                    <Label>Phone (WhatsApp)</Label>
                                    <Input
                                      value={editPhone}
                                      onChange={(e) => setEditPhone(e.target.value)}
                                      placeholder="37499123456 (digits, optional +)"
                                    />
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <input id="active" type="checkbox" checked={editActive} onChange={(e) => setEditActive(e.target.checked)} />
                                    <Label htmlFor="active">Active</Label>
                                  </div>
                                  <DialogFooter>
                                    <Button type="submit">Save changes</Button>
                                  </DialogFooter>
                                </form>
                              </DialogContent>
                            </Dialog>
                            {/* The server also rejects self-changes (400);
                                the button is disabled up front so the admin
                                cannot accidentally lock themselves out. */}
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={user.id === currentUserId}
                              title={user.id === currentUserId ? "You cannot change your own permissions" : undefined}
                              onClick={() => setPermissionsUserId(user.id)}
                            >
                              Permissions
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => handleRevokeSessions(user.id, user.email)}>
                              Revoke sessions
                            </Button>
                            <Button size="sm" variant="destructive" onClick={() => handleDeleteUser(user.id)}>
                              Delete
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="logs">
          <Card>
            <CardHeader>
              <CardTitle>Audit Logs</CardTitle>
              <CardDescription>Recent actions and events.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="max-h-[600px] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="border-b text-left">
                    <tr>
                      <th className="pb-2 font-medium">Time</th>
                      <th className="pb-2 font-medium">Action</th>
                      <th className="pb-2 font-medium">User</th>
                      <th className="pb-2 font-medium">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {logs.map((log) => (
                      <tr key={log.id}>
                        <td className="py-2 whitespace-nowrap">{new Date(log.createdAt).toLocaleString()}</td>
                        <td className="py-2">{log.action}</td>
                        <td className="py-2">{log.user ? `${log.user.name} (${log.user.email})` : "System"}</td>
                        <td className="py-2">{log.details}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <UserPermissionsDialog userId={permissionsUserId} onClose={() => setPermissionsUserId(null)} />
    </div>
  );
}
