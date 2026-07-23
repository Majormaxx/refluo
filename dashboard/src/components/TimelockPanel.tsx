"use client";
import { useState } from "react";
import { toast } from "sonner";
import { XCircle, Eye } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
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
  const [detailProposal, setDetailProposal] = useState<PendingProposal | null>(null);

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
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="outline" onClick={() => setDetailProposal(p)}>
                          <Eye className="size-3.5" />
                          Details
                        </Button>
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
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <Dialog
        open={detailProposal !== null}
        onOpenChange={(open) => {
          if (!open) setDetailProposal(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Proposal #{detailProposal?.id}</DialogTitle>
            <DialogDescription>
              Real on-chain calldata — the exact target, function, and arguments this proposal
              will execute once its timelock delay elapses.
            </DialogDescription>
          </DialogHeader>
          {detailProposal && (
            <div className="space-y-3 text-sm">
              <div>
                <div className="text-muted-foreground">Target</div>
                <div className="font-mono text-xs break-all">{detailProposal.target}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Function</div>
                <div className="font-mono text-xs">{detailProposal.fnName}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Arguments ({detailProposal.args.length})</div>
                {detailProposal.args.length === 0 ? (
                  <div className="text-xs text-muted-foreground">none</div>
                ) : (
                  <ol className="list-decimal space-y-1 pl-5">
                    {detailProposal.args.map((arg, i) => (
                      <li key={i} className="font-mono text-xs break-all">
                        {arg}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
              <div>
                <div className="text-muted-foreground">ETA</div>
                <div className="text-xs">{new Date(detailProposal.etaSeconds * 1000).toLocaleString()}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Proposer</div>
                <div className="font-mono text-xs break-all">{detailProposal.proposer}</div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
