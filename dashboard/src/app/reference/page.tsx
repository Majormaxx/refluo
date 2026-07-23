import { ContractAddressesPanel } from "@/components/ContractAddressesPanel";
import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";

export default function ReferencePage() {
  return (
    <PanelErrorBoundary title="Contract addresses crashed">
      <ContractAddressesPanel />
    </PanelErrorBoundary>
  );
}
