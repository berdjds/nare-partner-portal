"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import axios from "axios";
import { Building2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";

type ApplicationStatus = "SUBMITTED" | "INFO_REQUESTED" | "APPROVED" | "REJECTED";

const STATUS_LABELS: Record<ApplicationStatus, string> = {
  SUBMITTED: "Submitted",
  INFO_REQUESTED: "Info requested",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

const STATUS_BADGE_VARIANTS: Record<ApplicationStatus, "info" | "warning" | "success" | "danger"> = {
  SUBMITTED: "info",
  INFO_REQUESTED: "warning",
  APPROVED: "success",
  REJECTED: "danger",
};

interface ApplicationSummary {
  id: string;
  reference: string;
  status: ApplicationStatus;
  companyLegalName: string;
  tradingName: string | null;
  country: string;
  city: string;
  contactName: string;
  contactEmail: string;
  licenceExpiry: string;
  createdAt: string;
  reviewedAt: string | null;
}

function apiErrorMessage(err: any, fallback: string): string {
  const error = err?.response?.data?.error;
  return typeof error === "string" && error ? error : fallback;
}

export default function ReviewQueue() {
  const { toast } = useToast();
  const [items, setItems] = useState<ApplicationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<ApplicationStatus | "ALL">("ALL");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const fetchApplications = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string> = {};
      if (statusFilter !== "ALL") params.status = statusFilter;
      if (search.trim()) params.search = search.trim();
      const res = await axios.get("/api/admin/partners", { params });
      setItems(res.data);
    } catch (err: any) {
      const message = apiErrorMessage(err, "Failed to load the applications");
      setError(message);
      toast(message, "error");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search, toast]);

  useEffect(() => {
    fetchApplications();
  }, [fetchApplications]);

  function handleSearchSubmit(e: FormEvent) {
    e.preventDefault();
    setSearch(searchInput);
  }

  const filterOptions: { value: ApplicationStatus | "ALL"; label: string }[] = [
    { value: "ALL", label: "All" },
    { value: "SUBMITTED", label: "Submitted" },
    { value: "INFO_REQUESTED", label: "Info requested" },
    { value: "APPROVED", label: "Approved" },
    { value: "REJECTED", label: "Rejected" },
  ];

  const activeFilterLabel = filterOptions.find((o) => o.value === statusFilter)?.label ?? "All";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {filterOptions.map((option) => (
            <Button
              key={option.value}
              size="sm"
              variant={statusFilter === option.value ? "default" : "outline"}
              onClick={() => setStatusFilter(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <form onSubmit={handleSearchSubmit} className="flex items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="partner-search">Search by reference, company or contact</Label>
            <Input
              id="partner-search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Type a reference or name"
              className="w-64"
            />
          </div>
          <Button type="submit" variant="outline">
            <Search />
            Search
          </Button>
        </form>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading applications…</p>
      ) : error ? (
        <p className="text-sm text-muted-foreground">
          Could not load the applications. Check your connection and try reloading the page.
        </p>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No applications"
          description={
            statusFilter === "ALL" && !search
              ? "New partner applications will appear here."
              : `No applications match the "${activeFilterLabel}" filter${search ? ` and the search "${search}"` : ""}.`
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Reference</TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Licence expiry</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="pr-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="pl-4 font-mono text-xs">{a.reference}</TableCell>
                    <TableCell>
                      <div className="font-medium">{a.companyLegalName}</div>
                      {a.tradingName && (
                        <div className="text-xs text-muted-foreground">{a.tradingName}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div>{a.contactName}</div>
                      <div className="text-xs text-muted-foreground">{a.contactEmail}</div>
                    </TableCell>
                    <TableCell>
                      {a.city}, {a.country}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{a.licenceExpiry}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {new Date(a.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_BADGE_VARIANTS[a.status] ?? "neutral"}>
                        {STATUS_LABELS[a.status] ?? a.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      <Button size="sm" onClick={() => (window.location.href = `/admin/partners/${a.id}`)}>
                        Review
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
