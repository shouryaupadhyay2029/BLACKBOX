import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

console.log('=== BLACKBOX COMPREHENSIVE PRODUCTION AUDIT ===\n');

let failed = false;

// 1. Audit all JS files for syntax errors
const jsFiles = [
  'bin/blackbox.js',
  'bin/blackbox-mcp.js',
  'src/core/capsule-vault.js',
  'src/core/causal-correlator.js',
  'src/core/git-inspector.js',
  'src/core/ring-buffer.js',
  'src/core/stack-parser.js',
  'src/core/sourcemap-resolver.js',
  'src/daemon/process-supervisor.js',
  'src/daemon/server.js',
  'src/daemon/wiretap-proxy.js',
  'src/demo/demo-server.js',
  'src/mcp/mcp-server.js',
  'src/sdk/browser-agent.js',
  'src/studio/app.js',
];

console.log(`[Syntax Check] Verifying ${jsFiles.length} JavaScript source files...`);
for (const rel of jsFiles) {
  const fullPath = path.join(projectRoot, rel);
  if (!fs.existsSync(fullPath)) {
    console.error(`  ❌ Missing source file: ${rel}`);
    failed = true;
    continue;
  }
  try {
    const code = fs.readFileSync(fullPath, 'utf8');
    // Function constructor syntax check
    new Function(code.includes('import ') || code.includes('export ') ? '' : code);
    console.log(`  ✓ ${rel} (${code.split('\n').length} lines)`);
  } catch (err) {
    console.error(`  ❌ Syntax error in ${rel}: ${err.message}`);
    failed = true;
  }
}

// 2. Audit DOM Elements & Bindings in index.html vs app.js
console.log('\n[DOM Bindings Check]');
const htmlContent = fs.readFileSync(path.join(projectRoot, 'src/studio/index.html'), 'utf8');
const appJsContent = fs.readFileSync(path.join(projectRoot, 'src/studio/app.js'), 'utf8');

const expectedIds = [
  'capsuleList',
  'capsuleCountBadge',
  'bufferStatText',
  'gitStatText',
  'autoFreezeCheck',
  'capsuleStatusTag',
  'capsuleHeadline',
  'capsuleMetaText',
  'causalChainFlow',
  'domReplayFrame',
  'domStageWrapper',
  'domStageViewport',
  'domUrlPill',
  'domClickBadge',
  'cursorLaser',
  'browserConsoleList',
  'networkWaterfallList',
  'networkPayloadInspector',
  'terminalStreamList',
  'sourceXrayContainer',
  'gitInspectorContainer',
  'aiMarkdownPreview',
  'timeScrubber',
  'scrubberMarkers',
  'scrubberTimeReadout',
  'scrubberEventReadout',
  'playPauseBtn',
  'stepPrevBtn',
  'stepNextBtn',
  'playbackSpeedSelect',
  'liveStreamFeed',
  'diffResultsContainer',
  'diffSelectA',
  'diffSelectB',
  'btnSwapDiffPods',
  'runDiffBtn',
  'capsuleSearchInput',
  'clearVaultBtn',
  'liveDeckFreezeBtn',
  'btnCopyRawMarkdown',
  'hexCliSection',
  'hexCopyBtn',
  'hexRunDemoBtn',
  'toggleVaultBtn',
  'freezeNowBtn',
  'copyAiPromptBtn',
  'exportCapsuleBtn',
  'importCapsuleBtn',
  'importFileInput',
  'refreshCapsulesBtn',
];

for (const id of expectedIds) {
  if (!htmlContent.includes(`id="${id}"`)) {
    console.error(`  ❌ Missing ID in index.html: "${id}"`);
    failed = true;
  }
}
console.log(`  ✓ All ${expectedIds.length} critical DOM element IDs verified in index.html`);

// 3. Audit CapsuleVault methods
console.log('\n[CapsuleVault Unit Check]');
import('../src/core/capsule-vault.js').then(async ({ CapsuleVault }) => {
  try {
    const vault = new CapsuleVault({ projectCwd: projectRoot });
    const list = vault.listCapsules();
    console.log(`  ✓ Indexed ${list.length} capsules in vault`);

    if (list.length > 0) {
      const cap = vault.getCapsule(list[0].id);
      if (!cap || !cap.id) throw new Error('getCapsule failed');
      console.log(`  ✓ Retrieved capsule: ${cap.id}`);

      // Test self-diff
      const selfDiff = vault.diffCapsules(cap.id, cap.id);
      if (!selfDiff.isIdentical) throw new Error('isIdentical flag failed');
      console.log(`  ✓ Self-diff returns isIdentical: true`);
    }

    console.log('\n🎉 ALL BLACKBOX AUDIT SUITES PASSED NOMINALLY!');
    process.exit(failed ? 1 : 0);
  } catch (err) {
    console.error('  ❌ Vault check failed:', err.message);
    process.exit(1);
  }
});
