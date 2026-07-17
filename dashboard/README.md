# dashboard

Operator-facing web app. Phase 5 deliverable, must be live and feeding real
data by canary start — it's the SLA evidence, not an afterthought. Views
drafted in `refluo-prd-unified.md` §8.2 (local, not in this repo): vault
overview, SLA telemetry, guardian/pause panel, timelock proposal queue,
alerts config.

Auth model: wallet-signature challenge (SEP-10-style) mapped to the
admin/guardian addresses already on-chain for the vault — no separate
identity system. State-changing actions require the same on-chain signature
the contract demands; the dashboard is a signing UI, not a privileged
backend.

Not started. Placeholder so the Phase 0 workspace layout matches the
architecture doc.
