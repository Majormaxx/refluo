import { ConnectButton } from "@/components/ConnectButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { StatusBar } from "@/components/StatusBar";
import { VaultOverviewPanel } from "@/components/VaultOverviewPanel";
import { SlaTelemetryPanel } from "@/components/SlaTelemetryPanel";
import { GuardianPanel } from "@/components/GuardianPanel";
import { TimelockPanel } from "@/components/TimelockPanel";
import { AlertsPanel } from "@/components/AlertsPanel";
import { OnboardingChecklistPanel } from "@/components/OnboardingChecklistPanel";
import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";
import { Separator } from "@/components/ui/separator";

function Wordmark() {
  return (
    <div className="flex items-center gap-2">
      <svg viewBox="0 0 32 32" className="size-7 text-primary" aria-hidden>
        <path
          d="M16 3c6 5 11 10.2 11 15.5A11 11 0 1 1 5 18.5C5 13.2 10 8 16 3Z"
          fill="currentColor"
          opacity="0.18"
        />
        <path
          d="M16 8c4 3.6 7.5 7.6 7.5 11a7.5 7.5 0 1 1-15 0C8.5 15.6 12 11.6 16 8Z"
          fill="currentColor"
        />
      </svg>
      <span className="text-lg font-semibold tracking-tight">Refluo</span>
      <span className="text-sm text-muted-foreground">operator dashboard</span>
    </div>
  );
}

export default function Home() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b pb-4">
        <Wordmark />
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <ConnectButton />
        </div>
      </header>

      <StatusBar />

      <main className="flex flex-col gap-8">
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
          <div className="lg:col-span-2">
            <PanelErrorBoundary title="Timelock queue crashed">
              <TimelockPanel />
            </PanelErrorBoundary>
          </div>
        </section>

        <div className="flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Setup
          </span>
          <Separator className="flex-1" />
        </div>

        <section className="grid gap-6 lg:grid-cols-2">
          <PanelErrorBoundary title="Go-live checklist crashed">
            <OnboardingChecklistPanel />
          </PanelErrorBoundary>
          <PanelErrorBoundary title="Alerts config crashed">
            <AlertsPanel />
          </PanelErrorBoundary>
        </section>
      </main>
    </div>
  );
}
