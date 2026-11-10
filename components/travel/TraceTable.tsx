"use client";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { TraceRow } from "@/lib/travel/trace-table";

/**
 * Calculation breakdown table (v0.15.0) — renders the same buildTraceRows
 * output the internal costing PDF renders. Amount strings arrive pre-formatted
 * (grouped, ceiled, with currency) from the builder.
 */
export default function TraceTable({ rows, className }: { rows: TraceRow[]; className?: string }) {
  if (rows.length === 0) return null;
  return (
    <div className={cn("overflow-x-auto rounded-lg border", className)}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="ps-3">Description</TableHead>
            <TableHead>Basis</TableHead>
            <TableHead>Calculation</TableHead>
            <TableHead className="pe-3 text-end">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i} className={r.muted ? "text-muted-foreground" : undefined}>
              <TableCell className="ps-3">{r.description}</TableCell>
              <TableCell>{r.basis}</TableCell>
              <TableCell>{r.calculation}</TableCell>
              <TableCell
                className={cn("pe-3 text-end [font-variant-numeric:tabular-nums]", r.bold && "font-bold")}
              >
                {r.amount}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
