import path from 'node:path';
import { lintVault } from './lint-vault.js';

const vault = path.resolve(process.cwd(), process.env.CAIRN_VAULT_PATH?.trim() || 'cairn-vault');
const result = await lintVault(vault);
console.log(`Vault lint: ${result.valid} valid note(s), ${result.errors.length} error(s).`);
for (const error of result.errors) console.error(`Invalid note ${error.file}: ${error.reason}`);
if (result.errors.length > 0) process.exitCode = 1;
