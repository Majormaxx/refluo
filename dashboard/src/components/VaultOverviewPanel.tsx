"use client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { useApiResource } from "@/hooks/useApiResource";
import { SYSTEM_STATE_STYLE } from "@/lib/systemStateStyle";
import { cn } from "@/lib/utils";
import type { VaultOverview } from "@/lib/contracts/vaultOverview";

export function VaultOverviewPanel() {
  const { data, error, loading, reload } = useApiResource<VaultOverview>("/api/vault/overview");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Vault overview</CardTitle>
        {data && <CardDescription className="font-mono text-xs">{data.vaultAddress}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <PanelError error={error} onRetry={reload} />}
        {loading && <PanelSkeleton rows={5} />}
        {data && (
          <>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">System state</span>
                <span
                  className={cn(
                    "rounded-full px-2.5 py-0.5 text-xs font-medium",
                    SYSTEM_STATE_STYLE[data.systemState].badgeClassName,
                  )}
                >
                  {SYSTEM_STATE_STYLE[data.systemState].label}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Risk profile</span>
                <Badge variant={data.riskProfile === "Custom" ? "outline" : "secondary"}>
                  {data.riskProfile}
                </Badge>
              </div>
              <div>
                <span className="text-muted-foreground">Tier 0 target</span>{" "}
                {data.tier0Target} stroops
              </div>
              <div>
                <span className="text-muted-foreground">USDC balance</span> {data.usdcBalance} stroops
              </div>
              <div>
                <span className="text-muted-foreground">XLM balance</span> {data.xlmBalance} stroops
              </div>
              <div>
                <span className="text-muted-foreground">Critical floor</span>{" "}
                {data.criticalFloor} stroops
              </div>
            </div>

            {data.tier1Positions.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-medium">Tier 1 positions</h3>
                <ul className="space-y-1 text-sm">
                  {data.tier1Positions.map((p) => (
                    <li key={p.venue}>
                      <code className="text-xs">{p.venue}</code>: {p.amount}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <h3 className="mb-2 text-sm font-medium">Context rules (agent keys and expiry)</h3>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>id</TableHead>
                      <TableHead>name</TableHead>
                      <TableHead>valid until (ledger)</TableHead>
                      <TableHead>delegated signers</TableHead>
                      <TableHead>policies</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.contextRules.map((rule) => (
                      <TableRow key={rule.id}>
                        <TableCell>{rule.id}</TableCell>
                        <TableCell>{rule.name}</TableCell>
                        <TableCell>{rule.validUntilLedger ?? "never expires"}</TableCell>
                        <TableCell>
                          {rule.delegatedSigners.map((s) => (
                            <div key={s} className="font-mono text-xs">
                              {s.slice(0, 6)}…{s.slice(-6)}
                            </div>
                          ))}
                        </TableCell>
                        <TableCell>{rule.policies.length}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
