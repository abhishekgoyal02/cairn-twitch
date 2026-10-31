import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, type AppConfig } from '../config.js';
import { SafeLlmAdapter, type LlmOperationResult } from './llm.js';

export interface DiagnosticArguments { model?: string; }
export interface DiagnosticResult {
  provider: string;
  model?: string;
  outcome: string;
  status?: number;
  elapsedMs: number;
  validJsonGeneration: boolean;
}

interface HealthChecker { healthCheck(): Promise<LlmOperationResult<unknown>>; }
type AdapterFactory = (options: ConstructorParameters<typeof SafeLlmAdapter>[0]) => HealthChecker;

/** Parses diagnostic-only arguments; values never alter process.env or persisted config. */
export function parseDiagnosticArguments(args: readonly string[]): DiagnosticArguments {
  if (args.length === 0) return {};
  if (args.length !== 2 || args[0] !== '--model' || !isSafeModelArgument(args[1])) {
    throw new Error('Usage: npm run llm:diagnose -- [--model <model-id>]');
  }
  return { model: args[1] };
}

export async function runDiagnostic(
  config: Pick<AppConfig, 'llmProvider' | 'llmEndpoint' | 'llmApiKey' | 'llmModel' | 'llmFallbackModel'>,
  args: DiagnosticArguments,
  factory: AdapterFactory = (options) => new SafeLlmAdapter(options),
  now: () => number = Date.now,
): Promise<DiagnosticResult> {
  const model = args.model ?? config.llmModel;
  const started = now();
  try {
    const result = await factory({
      provider: config.llmProvider,
      endpoint: config.llmEndpoint,
      apiKey: config.llmApiKey,
      model,
      fallbackModel: config.llmFallbackModel,
    }).healthCheck();
    return {
      provider: config.llmProvider ?? 'none',
      model: result.model,
      outcome: result.outcome,
      status: result.status,
      elapsedMs: Math.max(0, now() - started),
      validJsonGeneration: result.outcome === 'success',
    };
  } catch {
    return {
      provider: config.llmProvider ?? 'none',
      model: safeOutputModel(model),
      outcome: 'diagnostic_error',
      elapsedMs: Math.max(0, now() - started),
      validJsonGeneration: false,
    };
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const parsed = parseDiagnosticArguments(args);
  const result = await runDiagnostic(loadConfig(), parsed);
  // Deliberately excludes credentials, endpoints, prompts, headers, and provider bodies.
  console.log(JSON.stringify(result));
  if (result.outcome !== 'success') process.exitCode = 1;
}

function isSafeModelArgument(value: string | undefined): value is string {
  return typeof value === 'string' && /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u.test(value);
}
function safeOutputModel(value: string | undefined): string | undefined {
  return isSafeModelArgument(value) ? value : undefined;
}

const entryPoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (entryPoint === import.meta.url) {
  void main().catch(() => {
    console.error(JSON.stringify({ outcome: 'configuration_error', validJsonGeneration: false }));
    process.exitCode = 1;
  });
}
