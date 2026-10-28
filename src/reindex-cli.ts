import { resolveVaultPath } from './config.js';
import { reindexVault } from './index/reindex.js';

async function main(): Promise<void> {
  const started = Date.now();
  const summary = await reindexVault(resolveVaultPath());
  console.log(`Reindexed ${summary.indexed} valid stone note(s) in ${Date.now() - started}ms.`);
  for (const failure of summary.invalid) {
    console.error(`Invalid note ${failure.file}: ${failure.reason}`);
  }
  if (summary.invalid.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`Reindex failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
