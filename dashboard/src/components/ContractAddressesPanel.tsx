"use client";
import { useState } from "react";
import { Copy, Check, ExternalLink } from "lucide-react";
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
import { useApiResource } from "@/hooks/useApiResource";
import type { ContextRuleSummary } from "@/lib/contracts/vaultOverview";

interface VaultAddresses {
  vaultAddress: string;
  riskEngineId: string;
  healthMonitorId: string;
  timelockId: string;
  usdcTokenId: string;
  xlmTokenId: string;
  contextRules: ContextRuleSummary[];
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      className="size-7 p-0"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      aria-label={`Copy ${value}`}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

function AddressRow({ label, address }: { label: string; address: string }) {
  return (
    <TableRow>
      <TableCell className="font-medium">{label}</TableCell>
      <TableCell className="font-mono text-xs">{address}</TableCell>
      <TableCell className="w-24">
        <div className="flex items-center gap-1">
          <CopyButton value={address} />
          <Button
            size="sm"
            variant="ghost"
            className="size-7 p-0"
            render={
              <a
                href={`https://stellar.expert/explorer/testnet/contract/${address}`}
                target="_blank"
                rel="noreferrer"
                aria-label={`View ${label} on stellar.expert`}
              />
            }
          >
            <ExternalLink className="size-3.5" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export function ContractAddressesPanel() {
  const { data, error, loading, reload } = useApiResource<VaultAddresses>("/api/vault/addresses");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Contract addresses</CardTitle>
        <CardDescription>
          The vault owner can always regain full control of this smart account directly against
          these real, deployed addresses — without Refluo&apos;s keeper, dashboard, or company
          being involved or even existing. Save these independently of this dashboard.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && <PanelError error={error} onRetry={reload} />}
        {loading && <PanelSkeleton rows={6} />}
        {data && (
          <>
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableBody>
                  <AddressRow label="Vault" address={data.vaultAddress} />
                  <AddressRow label="Risk engine" address={data.riskEngineId} />
                  <AddressRow label="Health monitor" address={data.healthMonitorId} />
                  <AddressRow label="Timelock" address={data.timelockId} />
                  <AddressRow label="USDC token" address={data.usdcTokenId} />
                  <AddressRow label="XLM token" address={data.xlmTokenId} />
                </TableBody>
              </Table>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium">Context rules (agent keys and policies)</h3>
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
                              {s}
                            </div>
                          ))}
                        </TableCell>
                        <TableCell>
                          {rule.policies.map((p) => (
                            <div key={p} className="font-mono text-xs">
                              {p}
                            </div>
                          ))}
                        </TableCell>
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
