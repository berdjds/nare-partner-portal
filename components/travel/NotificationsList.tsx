"use client";

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, badgeStatusTextStyles } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "./TravelShell";
import { StateBadge, apiError, formatDateTime } from "./utils";
import type { NotificationDeliveryView } from "./types";

interface NotificationsListProps {
  role: string;
  userId: string;
}

export default function NotificationsList({ role }: NotificationsListProps) {
  const { toast } = useToast();
  const [deliveries, setDeliveries] = useState<NotificationDeliveryView[]>([]);
  const [status, setStatus] = useState("ALL");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const isAdmin = role === "ADMIN";

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (status !== "ALL") params.set("status", status);
    axios
      .get(`/api/travel/notifications?${params.toString()}`)
      .then((res) => setDeliveries(res.data))
      .catch((err) => toast(apiError(err, "Failed to load notifications"), "error"));
  }, [status, toast]);

  useEffect(load, [load]);

  async function retry(id: string) {
    setBusyId(id);
    try {
      await axios.post("/api/travel/notifications/retry", { ids: [id] });
      toast("Delivery requeued", "success");
      load();
    } catch (err) {
      toast(apiError(err, "Retry failed"), "error");
    } finally {
      setBusyId(null);
    }
  }

  async function processQueue() {
    setProcessing(true);
    try {
      const res = await axios.post("/api/travel/notifications/process", { limit: 50 });
      toast(`Queue processed: ${JSON.stringify(res.data)}`, "success");
      load();
    } catch (err) {
      toast(apiError(err, "Process failed"), "error");
    } finally {
      setProcessing(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle={
          isAdmin
            ? "All workflow notification deliveries — one row per event, recipient and channel."
            : "Your workflow notification deliveries."
        }
        actions={
          isAdmin ? (
            <Button variant="outline" size="sm" onClick={processQueue} disabled={processing}>
              {processing ? "Processing..." : "Process queue"}
            </Button>
          ) : undefined
        }
      />
      <Card>
        <CardContent className="space-y-4 pt-4">
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              <SelectItem value="QUEUED">Queued</SelectItem>
              <SelectItem value="SENT">Sent</SelectItem>
              <SelectItem value="FAILED">Failed</SelectItem>
              <SelectItem value="SKIPPED_NO_DESTINATION">Skipped (no destination)</SelectItem>
            </SelectContent>
          </Select>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead>Body</TableHead>
                <TableHead>Error</TableHead>
                <TableHead>Created</TableHead>
                {isAdmin && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveries.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>
                    <a
                      className="font-medium text-primary underline-offset-4 hover:underline"
                      href={`/travel/requests/${d.event.requestId}`}
                    >
                      {d.event.type.replace(/_/g, " ")}
                    </a>
                  </TableCell>
                  <TableCell>
                    <Badge variant={d.channel === "WHATSAPP" ? "success" : "neutral"}>{d.channel}</Badge>
                  </TableCell>
                  <TableCell>
                    <StateBadge value={d.status} />
                    {d.attempts > 0 && <span className="ml-1 text-xs text-muted-foreground">×{d.attempts}</span>}
                  </TableCell>
                  <TableCell className="text-xs">{d.destination ?? "—"}</TableCell>
                  <TableCell className="max-w-xs">
                    <span className="line-clamp-2 text-xs">{d.body}</span>
                  </TableCell>
                  <TableCell className="max-w-xs">
                    <span className={cn("line-clamp-2 text-xs", badgeStatusTextStyles.danger)}>{d.lastError ?? ""}</span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{formatDateTime(d.createdAt)}</TableCell>
                  {isAdmin && (
                    <TableCell>
                      {d.status === "FAILED" && (
                        <Button size="sm" variant="outline" disabled={busyId === d.id} onClick={() => retry(d.id)}>
                          Retry
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
              {deliveries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                    No deliveries.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
