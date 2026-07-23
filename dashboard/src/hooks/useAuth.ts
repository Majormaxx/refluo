// Re-exported from AuthProvider.tsx: session state now lives in a context
// mounted once at the root layout, not fetched independently by every
// component that calls this hook. Kept as a stable import path so no
// existing call site needs to change.
export { useAuth, type AuthState } from "./AuthProvider";
