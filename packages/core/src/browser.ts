/**
 * Browser-safe entry point for @hivemind/core (`@hivemind/core/browser`).
 *
 * The main barrel pulls in node-only modules (registry uses `node:fs`). The
 * onboarding SPA must avoid those, so it imports from here — only the sponsored
 * onboarding logic, constants, and the delegate-key generator (straight from the
 * MemWal SDK, bypassing the node-touching accounts module).
 */

export * from "./onboard";
export * from "./chain";
export type { SuiClient } from "./sui";
export { MEMWAL, HIVEMIND, SUI_CLOCK, DEFAULT_NAMESPACE, MAX_DELEGATE_KEYS, type SuiNetwork } from "./constants";
export { generateDelegateKey } from "@mysten-incubation/memwal/account";
