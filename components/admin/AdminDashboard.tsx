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
import { useSocket } from "@/hooks/useSocket";
import { useToast } from "@/components/ui/toast";

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

export default function AdminDashboard() {
  const { connected, unauthorized, whatsAppState, disconnectSocket } = useSocket();
  const { toast } = useToast();

  const [users, setUsers] = useState<User[]>([]);
  const [logs, setLogs] = useState<Log[]>([]);
  const [loading, setLoading] = useState(false);
  const [buildInfo, setBuildInfo] = useState<{ version?: string; startedAt?: string } | null>(null);

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

  useEffect(() => {
    fetchUsers();
    fetchLogs();
    axios
      .get("/api/whatsapp/status")
      .then((res) => setBuildInfo({ version: res.data.version, startedAt: res.data.startedAt }))
      .catch(() => null);
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

  async function handleWhatsAppAction(action: "logout" | "reconnect") {
    setLoading(true);
    try {
      await axios.post("/api/whatsapp/status", { action });
      toast(action === "logout" ? "Logged out WhatsApp" : "Reconnecting WhatsApp", "success");
    } catch (err: any) {
      toast(err?.response?.data?.error || "Action failed", "error");
    } finally {
      setLoading(false);
    }
  }

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

      <Tabs defaultValue="connection" className="space-y-4">
        <TabsList>
          <TabsTrigger value="connection">Connection</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="connection">
          <Card>
            <CardHeader>
              <CardTitle>WhatsApp Connection</CardTitle>
              <CardDescription>
                Socket: <Badge variant={connected ? "default" : "destructive"}>{unauthorized ? "session expired" : connected ? "connected" : "offline"}</Badge>{" "}
                State: <Badge variant={whatsAppState?.state === "ready" ? "default" : "outline"}>{whatsAppState?.state || "initializing"}</Badge>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Button onClick={() => handleWhatsAppAction("reconnect")} disabled={loading}>
                  Reconnect
                </Button>
                <Button variant="destructive" onClick={() => handleWhatsAppAction("logout")} disabled={loading}>
                  Logout
                </Button>
              </div>

              {whatsAppState?.qrSvg ? (
                <div className="rounded-lg border bg-white p-4">
                  <p className="mb-2 text-sm font-medium">Scan this QR code with WhatsApp on your phone:</p>
                  <div dangerouslySetInnerHTML={{ __html: whatsAppState.qrSvg }} className="inline-block" />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {whatsAppState?.info || "Waiting for WhatsApp state..."}
                </p>
              )}
            </CardContent>
          </Card>
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
    </div>
  );
}
