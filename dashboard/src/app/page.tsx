import { ConnectButton } from "@/components/ConnectButton";
import { VaultOverviewPanel } from "@/components/VaultOverviewPanel";
import { SlaTelemetryPanel } from "@/components/SlaTelemetryPanel";
import { GuardianPanel } from "@/components/GuardianPanel";
import { TimelockPanel } from "@/components/TimelockPanel";
import { AlertsPanel } from "@/components/AlertsPanel";
import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";

export default function Home() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b pb-4">
        <h1 className="text-xl font-semibold">Refluo operator dashboard</h1>
        <ConnectButton />
      </header>
      <main className="flex flex-col gap-6">
        <PanelErrorBoundary title="Vault overview crashed">
          <VaultOverviewPanel />
        </PanelErrorBoundary>
        <PanelErrorBoundary title="SLA telemetry crashed">
          <SlaTelemetryPanel />
        </PanelErrorBoundary>
        <PanelErrorBoundary title="Guardian panel crashed">
          <GuardianPanel />
        </PanelErrorBoundary>
        <PanelErrorBoundary title="Timelock queue crashed">
          <TimelockPanel />
        </PanelErrorBoundary>
        <PanelErrorBoundary title="Alerts config crashed">
          <AlertsPanel />
        </PanelErrorBoundary>
      </main>
    </div>
  );
}
