"use client";

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";

interface ReportUser {
  id: string;
  email: string;
  name: string;
  role: string;
  active: boolean;
  proposed: string[];
}

interface ReportResponse {
  confirmed: boolean;
  confirmedAt: string | null;
  confirmedBy: string | null;
  users: ReportUser[];
}

export default function PermissionsReport() {
  const { toast } = useToast();
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);

  const fetchReport = useCallback(async () => {
    try {
      const res = await axios.get("/api/permissions/report");
      setReport(res.data);
    } catch {
      toast("Failed to load the proposed-permissions report", "error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  async function handleConfirm() {
    if (!window.confirm("Confirm the proposed permissions? Internal-cost access is then unlocked for granting to non-admin roles.")) return;
    setConfirming(true);
    try {
      await axios.post("/api/permissions/report");
      toast("Proposed permissions confirmed", "success");
      fetchReport();
    } catch (err: any) {
      // 409 means another admin confirmed first — refetch to show their stamp.
      if (err?.response?.status === 409) {
        fetchReport();
      } else {
        toast(err?.response?.data?.error || "Failed to confirm the report", "error");
      }
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Proposed permissions</CardTitle>
        <CardDescription>Migration preview for the per-user permission model.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <p className="text-sm text-muted-foreground">
          This report lists the permissions every existing user would receive from their role preset. Until an
          admin confirms it, internal-cost permissions (travel.internal.view / travel.internal.download) stay
          admin-only (D2/D3).
        </p>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading report…</p>
        ) : !report ? (
          <p className="text-sm text-muted-foreground">Could not load the report.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left">
                  <tr>
                    <th className="pb-2 font-medium">User</th>
                    <th className="pb-2 font-medium">Role</th>
                    <th className="pb-2 font-medium">Status</th>
                    <th className="pb-2 font-medium">Proposed permissions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {report.users.map((user) => (
                    <tr key={user.id}>
                      <td className="py-2">
                        <div>{user.name}</div>
                        <div className="text-xs text-muted-foreground">{user.email}</div>
                      </td>
                      <td className="py-2">{user.role}</td>
                      <td className="py-2">
                        <Badge variant={user.active ? "default" : "outline"}>{user.active ? "Active" : "Inactive"}</Badge>
                      </td>
                      <td className="py-2">
                        <code className="font-mono text-xs">{user.proposed.join(", ")}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {report.confirmed ? (
              <p className="text-sm">
                <Badge variant="default">Confirmed</Badge>{" "}
                <span className="text-muted-foreground">
                  by {report.confirmedBy ?? "unknown"}
                  {report.confirmedAt && ` on ${new Date(report.confirmedAt).toLocaleString()}`}
                </span>
              </p>
            ) : (
              <Button onClick={handleConfirm} disabled={confirming}>
                {confirming ? "Confirming…" : "Confirm proposed permissions"}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
