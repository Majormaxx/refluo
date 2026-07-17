# dashboard

Operator-facing web app. Must be live and feeding real data before any
mainnet canary — it's the SLA evidence, not an afterthought. Planned views:
vault overview, SLA telemetry, guardian/pause panel, timelock proposal
queue, alerts config. Full spec tracked internally, not in this repo.

Auth model: wallet-signature challenge (SEP-10-style) mapped to the
admin/guardian addresses already on-chain for the vault — no separate
identity system. State-changing actions require the same on-chain signature
the contract demands; the dashboard is a signing UI, not a privileged
backend.

Not started. Placeholder so the workspace layout matches the architecture
doc.
