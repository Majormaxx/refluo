"use client";
import { useState } from "react";
import { toast } from "sonner";
import { XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { PanelError } from "@/components/PanelError";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { useAuth } from "@/hooks/useAuth";
import { useApiResource } from "@/hooks/useApiResource";
import { cancelProposalAsAdmin } from "@/lib/actions/timelockActions";
import { describeActionError } from "@/lib/actions/actionError";
import type { PendingProposal } from "@/lib/contracts/timelockProposals";

export function TimelockPanel() {
  const { role, address } = useAuth();
  const { data, error, loading, reload } = useApiResource<{ proposals: PendingProposal[] }>(
    "/api/timelock/proposals",
  );
  const [busyId, setBusyId] = useState<string | null>(null);

  async function handleCancel(id: string) {
    if (!address) return;
    setBusyId(id);
    try {
      const status = await cancelProposalAsAdmin(id, address);
      toast.success(`Cancel of #${id} submitted`, { description: `Transaction status: ${status}` });
      reload();
    } catch (err) {
      const { title, description } = describeActionError(err);
      toast.error(title, { description: `#${id}: ${description}` });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Timelock queue</CardTitle>
        <CardDescription>
          Anyone can view this queue; only the admin can cancel (watcher transparency).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <PanelError error={error} onRetry={reload} />}
        {loading && <PanelSkeleton rows={3} />}
        {data && data.proposals.length === 0 && (
          <p className="text-sm text-muted-foreground">No pending proposals.</p>
        )}
        {data && data.proposals.length > 0 && (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>id</TableHead>
                  <TableHead>eta</TableHead>
                  <TableHead>target</TableHead>
                  <TableHead>function</TableHead>
                  <TableHead>proposer</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.proposals.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{p.id}</TableCell>
                    <TableCell>{new Date(p.etaSeconds * 1000).toLocaleString()}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {p.target.slice(0, 6)}…{p.target.slice(-6)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{p.fnName}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {p.proposer.slice(0, 6)}…{p.proposer.slice(-6)}
                    </TableCell>
                    <TableCell>
                      {role === "admin" && (
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => handleCancel(p.id)}
                          disabled={busyId === p.id}
                        >
                          <XCircle className="size-3.5" />
                          {busyId === p.id ? "Signing…" : "Cancel"}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
