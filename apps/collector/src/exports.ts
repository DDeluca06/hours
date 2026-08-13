// Public surface of the collector, consumed by the CLI and the MCP server.
// Both need `sweep` (gather signals) and `reconstruct` (turn them into drafts),
// and neither should reach into the other app's source tree to get them.
export * from './collect.js';
export * from './reconstruct.js';
export * from './tasks.js';
export { collectGitSignals, collectCheckoutSignals, gitIdentity, isGitRepo } from './git.js';
export { collectSessionSignals, summarizePrompt, SESSIONS_ROOT } from './claude-sessions.js';
export {
  collectOpenCodeSignals,
  hasOpenCodeStorage,
  localizeHome,
  OPENCODE_STORAGE,
} from './opencode-sessions.js';
export {
  collectEditorHistorySignals,
  defaultHistoryRoots,
  resourcePath,
} from './editor-history.js';
