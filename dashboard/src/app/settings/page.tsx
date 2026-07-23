import { OnboardingChecklistPanel } from "@/components/OnboardingChecklistPanel";
import { AlertsPanel } from "@/components/AlertsPanel";
import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";

export default function SettingsPage() {
  return (
    <section className="grid gap-6 lg:grid-cols-2">
      <PanelErrorBoundary title="Go-live checklist crashed">
        <OnboardingChecklistPanel />
      </PanelErrorBoundary>
      <PanelErrorBoundary title="Alerts config crashed">
        <AlertsPanel />
      </PanelErrorBoundary>
    </section>
  );
}
