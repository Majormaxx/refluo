import { PauseHistoryPanel } from "@/components/PauseHistoryPanel";
import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";

export default function IncidentsPage() {
  return (
    <PanelErrorBoundary title="Incident history crashed">
      <PauseHistoryPanel />
    </PanelErrorBoundary>
  );
}
