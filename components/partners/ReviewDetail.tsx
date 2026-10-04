"use client";

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, badgeStatusTextStyles } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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

const DOCUMENT_KIND_LABELS: Record<string, string> = {
  TRADE_LICENCE: "Trade licence",
  SIGNATORY_ID: "Signatory ID",
  OTHER: "Other",
};

interface PartnerDocument {
  id: string;
  kind: string;
  originalName: string;
  mime: string;
  size: number;
  sha256: string;
  createdAt: string;
}

interface PartnerApplication {
  id: string;
  reference: string;
  status: ApplicationStatus;
  companyLegalName: string;
  tradingName?: string | null;
  country: string;
  city: string;
  address: string;
  website?: string | null;
  licenceNumber: string;
  licenceAuthority: string;
  licenceExpiry: string;
  contactName: string;
  contactRole?: string | null;
  contactEmail: string;
  contactPhone: string;
  secondContactName?: string | null;
  secondContactEmail?: string | null;
  secondContactPhone?: string | null;
  notes?: string | null;
  consentKyc: boolean;
  consentChannels: boolean;
  consentVersion: string;
  createdAt: string;
  updatedAt: string;
  reviewedById?: string | null;
  reviewedAt?: string | null;
  decisionNote?: string | null;
  agencyId?: string | null;
  documents: PartnerDocument[];
}

function apiErrorMessage(err: any, fallback: string): string {
  const error = err?.response?.data?.error;
  return typeof error === "string" && error ? error : fallback;
}

// Mirrors proposeShortCode() in lib/partners/review.ts: letters of the legal
// name, uppercased, first 10, empty when fewer than 3 letters.
function proposeShortCode(companyLegalName: string): string {
  const proposed = companyLegalName.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 10);
  return proposed.length >= 3 ? proposed : "";
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

export default function ReviewDetail({ applicationId }: { applicationId: string }) {
  const { toast } = useToast();
  const [application, setApplication] = useState<PartnerApplication | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shortCode, setShortCode] = useState("");
  const [decisionNote, setDecisionNote] = useState("");
  const [submitting, setSubmitting] = useState<"approve" | "reject" | "request-info" | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchApplication = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const res = await axios.get(`/api/admin/partners/${applicationId}`);
      const data: PartnerApplication = res.data;
      setApplication(data);
      setShortCode(proposeShortCode(data.companyLegalName));
    } catch (err: any) {
      if (err?.response?.status === 404) {
        setNotFound(true);
      } else {
        const message = apiErrorMessage(err, "Failed to load the application");
        setError(message);
        toast(message, "error");
      }
    } finally {
      setLoading(false);
    }
  }, [applicationId, toast]);

  useEffect(() => {
    fetchApplication();
  }, [fetchApplication]);

  async function submitDecision(action: "approve" | "reject" | "request-info") {
    setSubmitting(action);
    try {
      const body: { action: string; shortCode?: string; decisionNote?: string } = { action };
      if (action === "approve") {
        if (shortCode.trim()) body.shortCode = shortCode.trim();
      } else {
        body.decisionNote = decisionNote.trim();
      }
      await axios.post(`/api/admin/partners/${applicationId}/decision`, body);
      toast(
        action === "approve"
          ? "Application approved"
          : action === "reject"
            ? "Application rejected"
            : "More information requested",
        "success"
      );
      setDecisionNote("");
      await fetchApplication();
    } catch (err: any) {
      toast(apiErrorMessage(err, "Failed to record the decision"), "error");
    } finally {
      setSubmitting(null);
    }
  }

  async function handleDeleteDocuments() {
    if (!window.confirm("Delete all KYC documents for this application? This cannot be undone.")) return;
    setDeleting(true);
    try {
      const res = await axios.delete(`/api/admin/partners/${applicationId}`);
      const deletedFiles = typeof res.data?.deletedFiles === "number" ? res.data.deletedFiles : 0;
      toast(`Deleted ${deletedFiles} document file${deletedFiles === 1 ? "" : "s"}`, "success");
      await fetchApplication();
    } catch (err: any) {
      toast(apiErrorMessage(err, "Failed to delete the documents"), "error");
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading application…</p>;
  }
  if (notFound) {
    return <p className="text-sm text-muted-foreground">This application could not be found. It may have been removed.</p>;
  }
  if (error || !application) {
    return (
      <p className="text-sm text-muted-foreground">
        Could not load the application. Check your connection and try reloading the page.
      </p>
    );
  }

  const app = application;
  const approved = app.status === "APPROVED";

  // Licence expiry is a YYYY-MM-DD string; compare calendar days, not instants.
  const [expiryYear, expiryMonth, expiryDay] = app.licenceExpiry.split("-").map(Number);
  const expiryDate = new Date(expiryYear, expiryMonth - 1, expiryDay);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysUntilExpiry = Math.round((expiryDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  const licenceExpired = daysUntilExpiry < 0;
  const licenceExpiringSoon = !licenceExpired && daysUntilExpiry <= 30;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>{app.companyLegalName}</CardTitle>
              <CardDescription>
                <span className="font-mono text-xs">{app.reference}</span>
                {" · "}Submitted {new Date(app.createdAt).toLocaleDateString()}
              </CardDescription>
            </div>
            <Badge variant={STATUS_BADGE_VARIANTS[app.status] ?? "neutral"}>
              {STATUS_LABELS[app.status] ?? app.status}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <Detail label="Legal name">{app.companyLegalName}</Detail>
            {app.tradingName && <Detail label="Trading name">{app.tradingName}</Detail>}
            <Detail label="Country">{app.country}</Detail>
            <Detail label="City">{app.city}</Detail>
            <Detail label="Address">{app.address}</Detail>
            {app.website && (
              <Detail label="Website">
                <a href={app.website} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">
                  {app.website}
                </a>
              </Detail>
            )}
          </dl>
          {app.notes && (
            <div className="mt-4 border-t pt-4">
              <p className="text-xs text-muted-foreground">Notes from the applicant</p>
              <p className="mt-1 whitespace-pre-wrap text-sm">{app.notes}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Trade licence</CardTitle>
          <CardDescription>Check the licence details against the uploaded document.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <Detail label="Licence number">{app.licenceNumber}</Detail>
            <Detail label="Issuing authority">{app.licenceAuthority}</Detail>
            <Detail label="Expiry date">{app.licenceExpiry}</Detail>
          </dl>
          {licenceExpired && (
            <p className={`mt-3 text-sm ${badgeStatusTextStyles.warning}`}>This licence has expired.</p>
          )}
          {licenceExpiringSoon && (
            <p className={`mt-3 text-sm ${badgeStatusTextStyles.warning}`}>
              This licence expires soon ({app.licenceExpiry}). You may want to ask for a renewal.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Documents</CardTitle>
          <CardDescription>KYC documents uploaded with the application.</CardDescription>
        </CardHeader>
        <CardContent>
          {app.documents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No documents on file.</p>
          ) : (
            <ul className="divide-y">
              {app.documents.map((doc) => (
                <li key={doc.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div className="flex items-center gap-3">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">{doc.originalName}</p>
                      <p className="text-xs text-muted-foreground">
                        {DOCUMENT_KIND_LABELS[doc.kind] ?? doc.kind}
                        {" · "}{formatSize(doc.size)}
                        {" · "}Uploaded {new Date(doc.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <Button variant="outline" size="sm" asChild>
                    <a href={`/api/admin/partners/${applicationId}/documents/${doc.id}`}>Download</a>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Contacts</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <Detail label="Primary contact">{app.contactName}</Detail>
            {app.contactRole && <Detail label="Role">{app.contactRole}</Detail>}
            <Detail label="Email">{app.contactEmail}</Detail>
            <Detail label="Phone">{app.contactPhone}</Detail>
          </dl>
          {app.secondContactName && (
            <div className="mt-4 border-t pt-4">
              <p className="mb-3 text-xs text-muted-foreground">Second contact</p>
              <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                <Detail label="Name">{app.secondContactName}</Detail>
                {app.secondContactEmail && <Detail label="Email">{app.secondContactEmail}</Detail>}
                {app.secondContactPhone && <Detail label="Phone">{app.secondContactPhone}</Detail>}
              </dl>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Review history</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <Detail label="Submitted">{new Date(app.createdAt).toLocaleString()}</Detail>
            {app.reviewedAt && <Detail label="Reviewed">{new Date(app.reviewedAt).toLocaleString()}</Detail>}
          </dl>
          {app.decisionNote && (
            <div className="mt-4 border-t pt-4">
              <p className="text-xs text-muted-foreground">Decision note</p>
              <p className="mt-1 whitespace-pre-wrap text-sm">{app.decisionNote}</p>
            </div>
          )}
          {approved && app.agencyId && (
            <p className="mt-4 text-sm text-muted-foreground">Agency created: {app.agencyId}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Decision</CardTitle>
          <CardDescription>Approve the application, reject it, or ask the applicant for more information.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {approved ? (
            <p className="text-sm text-muted-foreground">
              This application has been approved and the agency account has been created. Approval is final.
            </p>
          ) : (
            <>
              <div className="max-w-xs space-y-1.5">
                <Label htmlFor="short-code">Agency short code</Label>
                <Input
                  id="short-code"
                  value={shortCode}
                  onChange={(e) => setShortCode(e.target.value.toUpperCase())}
                  maxLength={10}
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">3–10 uppercase letters; leave as proposed or edit.</p>
              </div>
              <div>
                <Button onClick={() => submitDecision("approve")} disabled={submitting !== null}>
                  {submitting === "approve" ? "Approving…" : "Approve application"}
                </Button>
              </div>

              <div className="space-y-1.5 border-t pt-5">
                <Label htmlFor="decision-note">Note to the applicant</Label>
                <Textarea
                  id="decision-note"
                  value={decisionNote}
                  onChange={(e) => setDecisionNote(e.target.value)}
                  placeholder="Explain what is missing or why the application is rejected."
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="destructive"
                  onClick={() => submitDecision("reject")}
                  disabled={submitting !== null || !decisionNote.trim()}
                >
                  {submitting === "reject" ? "Rejecting…" : "Reject application"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => submitDecision("request-info")}
                  disabled={submitting !== null || !decisionNote.trim()}
                >
                  {submitting === "request-info" ? "Sending…" : "Request more info"}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Delete documents</CardTitle>
          <CardDescription>
            Remove the uploaded KYC documents from storage. The application itself is kept.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {app.documents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No documents on file.</p>
          ) : (
            <Button variant="outline" className="text-destructive" onClick={handleDeleteDocuments} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete all documents"}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
