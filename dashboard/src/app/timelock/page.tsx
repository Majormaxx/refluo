import { TimelockPanel } from "@/components/TimelockPanel";
import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";

export default function TimelockPage() {
  return (
    <PanelErrorBoundary title="Timelock queue crashed">
      <TimelockPanel />
    </PanelErrorBoundary>
  );
}
