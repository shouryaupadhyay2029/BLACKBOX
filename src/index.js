/**
 * BLACKBOX — The Localhost Flight Recorder & Causal Time-Travel Engine
 * Programmatic Node.js SDK Entry Point
 */

export { BlackboxDaemonServer } from './daemon/server.js';
export { WiretapProxy } from './daemon/wiretap-proxy.js';
export { ProcessSupervisor } from './daemon/process-supervisor.js';
export { CapsuleVault } from './core/capsule-vault.js';
export { BlackboxRingBuffer, KalaRingBuffer } from './core/ring-buffer.js';
export { buildCausalAnalysis } from './core/causal-correlator.js';
export { parseStackAndCode, resolveLocalFile, extractSourceSnippet } from './core/stack-parser.js';
export { captureGitState, correlateStackWithGitDiff } from './core/git-inspector.js';
export { BlackboxMcpServer, KalaMcpServer } from './mcp/mcp-server.js';
