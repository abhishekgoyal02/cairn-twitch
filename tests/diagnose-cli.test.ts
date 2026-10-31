import { describe, expect, it } from 'vitest';
import { parseDiagnosticArguments, runDiagnostic } from '../src/intelligence/diagnose-cli.js';

const config = {
  llmProvider: 'groq' as const,
  llmEndpoint: undefined,
  llmApiKey: 'test-secret',
  llmModel: 'configured-model',
  llmFallbackModel: undefined,
};

describe('llm:diagnose argument handling', () => {
  it('accepts a safe diagnostic-only model override', () => {
    expect(parseDiagnosticArguments(['--model', 'openai/gpt-oss-20b'])).toEqual({ model: 'openai/gpt-oss-20b' });
    expect(config.llmModel).toBe('configured-model');
  });

  it('rejects unknown, missing, and unsafe arguments without exposing them', () => {
    expect(() => parseDiagnosticArguments(['--model'])).toThrow(/Usage/);
    expect(() => parseDiagnosticArguments(['--other', 'model'])).toThrow(/Usage/);
    expect(() => parseDiagnosticArguments(['--model', 'model?key=secret'])).toThrow(/Usage/);
  });

  it('uses the override for this adapter instance only and reports success safely', async () => {
    const options: unknown[] = [];
    const times = [100, 145];
    const result = await runDiagnostic(config, { model: 'openai/gpt-oss-20b' }, (input) => {
      options.push(input);
      return { healthCheck: async () => ({ outcome: 'success', value: { ok: true }, model: 'openai/gpt-oss-20b' }) };
    }, () => times.shift() ?? 145);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ model: 'openai/gpt-oss-20b', apiKey: 'test-secret' });
    expect(result).toEqual({ provider: 'groq', model: 'openai/gpt-oss-20b', outcome: 'success', elapsedMs: 45, validJsonGeneration: true });
    expect(config.llmModel).toBe('configured-model');
  });

  it('returns a typed timeout diagnostic without leaking credentials', async () => {
    const result = await runDiagnostic(config, {}, () => ({ healthCheck: async () => ({ outcome: 'timeout', model: 'configured-model' }) }));
    expect(result).toMatchObject({ provider: 'groq', model: 'configured-model', outcome: 'timeout', validJsonGeneration: false });
    expect(JSON.stringify(result)).not.toContain('test-secret');
  });

  it('handles an unexpected rejected health check as a sanitized diagnostic error', async () => {
    const result = await runDiagnostic(config, {}, () => ({ healthCheck: async () => { throw new Error('api_key=test-secret'); } }));
    expect(result).toMatchObject({ provider: 'groq', model: 'configured-model', outcome: 'diagnostic_error', validJsonGeneration: false });
    expect(JSON.stringify(result)).not.toContain('test-secret');
  });
});
