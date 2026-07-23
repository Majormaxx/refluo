import { StatusBar } from "@/components/StatusBar";
import { VaultOverviewPanel } from "@/components/VaultOverviewPanel";
import { SlaTelemetryPanel } from "@/components/SlaTelemetryPanel";
import { GuardianPanel } from "@/components/GuardianPanel";
import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";

export default function Home() {
  return (
    <>
      <StatusBar />
      <section className="grid gap-6 lg:grid-cols-2">
        <PanelErrorBoundary title="Vault overview crashed">
          <VaultOverviewPanel />
        </PanelErrorBoundary>
        <PanelErrorBoundary title="Guardian panel crashed">
          <GuardianPanel />
        </PanelErrorBoundary>
        <div className="lg:col-span-2">
          <PanelErrorBoundary title="SLA telemetry crashed">
            <SlaTelemetryPanel />
          </PanelErrorBoundary>
        </div>
      </section>
    </>
  );
}
