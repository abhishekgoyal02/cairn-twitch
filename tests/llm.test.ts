import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeLlmAdapter, isGroqStrictResponseFormat } from '../src/intelligence/llm.js';

const candidate = { id: 'st_a1b2c3', title: 'Kevin', body: 'Kevin is the boss.' };
const groqPayload = (value: unknown, finishReason = 'stop') => ({
  choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) }, finish_reason: finishReason }],
});

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('SafeLlmAdapter Groq provider', () => {
  it('rejects invalid Groq strict-schema contracts before they reach the provider', () => {
    expect(isGroqStrictResponseFormat({ type: 'json_schema', json_schema: {
      name: 'broken', strict: true,
      schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: [], additionalProperties: false },
    } })).toBe(false);
    expect(isGroqStrictResponseFormat({ type: 'json_schema', json_schema: {
      name: 'broken', strict: true,
      schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] },
    } })).toBe(false);
  });

  it('uses deterministic fallbacks when no provider is configured', async () => {
    const adapter = new SafeLlmAdapter();
    await expect(adapter.suggestLinks({ stoneText: 'Kevin', candidates: [candidate] })).resolves.toEqual({ ids: [] });
    await expect(adapter.answerWhy({ question: 'Kevin', notes: [candidate] })).resolves.toEqual({ answer: '', citations: [] });
  });

  it('uses Groq Chat Completions, bearer authentication, and strict JSON schema', async () => {
    let url = ''; let init: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      url = String(input); init = options;
      return new Response(JSON.stringify(groqPayload({ ids: [candidate.id] })), { status: 200 });
    }));
    const adapter = new SafeLlmAdapter({ provider: 'groq', apiKey: 'secret-key', model: 'openai/gpt-oss-20b' });
    await expect(adapter.suggestLinks({ stoneText: 'Kevin', candidates: [candidate] })).resolves.toEqual({ ids: [candidate.id] });
    const request = JSON.parse(String(init?.body)) as Record<string, any>;
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer secret-key');
    expect(request.model).toBe('openai/gpt-oss-20b');
    expect(request.max_completion_tokens).toBe(96);
    expect(request.reasoning_effort).toBe('low');
    expect(request.include_reasoning).toBe(false);
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0].role).toBe('user');
    expect(request.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'cairn_links', strict: true,
        schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'], additionalProperties: false },
      },
    });
  });

  it('uses the configured Groq model or the documented default model', async () => {
    const models: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      models.push((JSON.parse(String(init?.body)) as { model: string }).model);
      return new Response(JSON.stringify(groqPayload({ ids: [] })), { status: 200 });
    }));
    await new SafeLlmAdapter({ provider: 'groq', apiKey: 'secret-key' }).suggestLinks({ stoneText: 'Kevin', candidates: [candidate] });
    await new SafeLlmAdapter({ provider: 'groq', apiKey: 'secret-key', model: 'meta-llama/llama-4-scout-17b-16e-instruct' }).suggestLinks({ stoneText: 'Kevin two', candidates: [candidate] });
    expect(models).toEqual(['openai/gpt-oss-20b', 'meta-llama/llama-4-scout-17b-16e-instruct']);
  });

  it('uses an explicitly configured Groq-compatible endpoint without changing authentication or payload shape', async () => {
    let url = ''; let headers: HeadersInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input); headers = init?.headers;
      return new Response(JSON.stringify(groqPayload({ ids: [] })), { status: 200 });
    }));
    await new SafeLlmAdapter({ provider: 'groq', apiKey: 'secret-key', endpoint: 'http://127.0.0.1:9999/chat/completions' })
      .suggestLinks({ stoneText: 'Kevin', candidates: [candidate] });
    expect(url).toBe('http://127.0.0.1:9999/chat/completions');
    expect((headers as Record<string, string>).authorization).toBe('Bearer secret-key');
  });

  it('parses validated relationship, lore, and why responses from Groq', async () => {
    const responses = [
      groqPayload({ ids: ['st_a1b2c3', 'st_a1b2c3', 'invented'] }),
      groqPayload({ title: 'Kevin lore', stoneIds: ['st_a1b2c3', 'invented'] }),
      groqPayload({ answer: 'Kevin is the boss. Source: st_a1b2c3.', citations: ['st_a1b2c3', 'invented'] }),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200 })));
    const adapter = new SafeLlmAdapter({ provider: 'groq', apiKey: 'secret-key', model: 'openai/gpt-oss-20b' });
    await expect(adapter.suggestLinks({ stoneText: 'Kevin', candidates: [candidate] })).resolves.toEqual({ ids: ['st_a1b2c3'] });
    await expect(adapter.suggestLore({ stoneText: 'Kevin', stoneIds: ['st_a1b2c3'] })).resolves.toEqual({ title: 'Kevin lore', stoneIds: ['st_a1b2c3'] });
    await expect(adapter.answerWhy({ question: 'Kevin', notes: [candidate] })).resolves.toEqual({ answer: 'Kevin is the boss. Source: st_a1b2c3.', citations: ['st_a1b2c3'] });
  });

  it('uses operation-specific strict JSON schemas and token budgets', async () => {
    const bodies: Array<Record<string, any>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, any>);
      const name = bodies.at(-1)?.response_format.json_schema.name;
      const value = name === 'cairn_lore' ? { title: 'Kevin lore', stoneIds: ['st_a1b2c3'] } : name === 'cairn_why' ? { answer: 'Kevin.', citations: ['st_a1b2c3'] } : { ok: true };
      return new Response(JSON.stringify(groqPayload(value)), { status: 200 });
    }));
    const adapter = new SafeLlmAdapter({ provider: 'groq', apiKey: 'secret-key' });
    await adapter.suggestLore({ stoneText: 'Kevin', stoneIds: ['st_a1b2c3'] });
    await adapter.answerWhy({ question: 'Kevin', notes: [candidate] });
    await adapter.healthCheck();
    expect(bodies.map((body) => body.response_format)).toEqual([
      {
        type: 'json_schema', json_schema: {
          name: 'cairn_lore', strict: true,
          schema: { type: 'object', properties: { title: { type: 'string' }, stoneIds: { type: 'array', items: { type: 'string' } } }, required: ['title', 'stoneIds'], additionalProperties: false },
        },
      },
      {
        type: 'json_schema', json_schema: {
          name: 'cairn_why', strict: true,
          schema: { type: 'object', properties: { answer: { type: 'string' }, citations: { type: 'array', items: { type: 'string' } } }, required: ['answer', 'citations'], additionalProperties: false },
        },
      },
      {
        type: 'json_schema', json_schema: {
          name: 'cairn_health', strict: true,
          schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
        },
      },
    ]);
    expect(bodies.map((body) => body.max_completion_tokens)).toEqual([96, 192, 32]);
    expect(bodies.every((body) => body.reasoning_effort === 'low' && body.include_reasoning === false && body.messages.length === 1 && body.messages[0].role === 'user')).toBe(true);
  });

  it.each([
    ['invalid JSON', groqPayload('{not json'), 'malformed_response', 'invalid_json'],
    ['missing choices', {}, 'malformed_response', 'missing_choices'],
    ['missing content', { choices: [{ message: {}, finish_reason: 'stop' }] }, 'malformed_response', 'missing_content'],
    ['completion limit', groqPayload('{"ids"', 'length'), 'truncated_output', 'completion_limit'],
    ['content filter', { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }, 'blocked_output', 'content_filter'],
    ['model refusal', { choices: [{ message: { refusal: 'refused' }, finish_reason: 'stop' }] }, 'blocked_output', 'model_refusal'],
  ])('classifies Groq %s without response-content leakage', async (_label, payload, outcome, detail) => {
    const logs: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));
    const adapter = new SafeLlmAdapter({ provider: 'groq', apiKey: 'secret-key', log: (entry) => logs.push(entry) });
    await expect(adapter.suggestLinks({ stoneText: 'private stone', candidates: [candidate] })).resolves.toEqual({ ids: [] });
    expect(logs[0]).toContain(`outcome=${outcome}`);
    expect(logs[0]).toContain(`detail=${detail}`);
    expect(logs[0]).not.toContain('private stone');
    expect(logs[0]).not.toContain('secret-key');
  });

  it('rejects extra fields, overlong lore titles, and invented link IDs', async () => {
    const logs: string[] = [];
    const responses = [
      groqPayload({ ids: ['st_a1b2c3'], loreTitle: 'must not be accepted' }),
      groqPayload({ title: 'x'.repeat(121), stoneIds: ['st_a1b2c3'] }),
      groqPayload({ ids: ['invented', 'invented'] }),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200 })));
    const adapter = new SafeLlmAdapter({ provider: 'groq', apiKey: 'secret-key', log: (entry) => logs.push(entry) });
    await expect(adapter.suggestLinks({ stoneText: 'Kevin', candidates: [candidate] })).resolves.toEqual({ ids: [] });
    await expect(adapter.suggestLore({ stoneText: 'Kevin', stoneIds: ['st_a1b2c3'] })).resolves.toBeUndefined();
    await expect(adapter.suggestLinks({ stoneText: 'Kevin second', candidates: [candidate] })).resolves.toEqual({ ids: [] });
    expect(logs.some((entry) => entry.includes('invalid_link_schema'))).toBe(true);
    expect(logs.some((entry) => entry.includes('unsupplied_candidate_id'))).toBe(true);
  });

  it('does not retry authentication failures', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'private api_key=secret-key' } }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new SafeLlmAdapter({ provider: 'groq', apiKey: 'secret-key', fallbackModel: 'openai/gpt-oss-120b' });
    await adapter.suggestLinks({ stoneText: 'Kevin', candidates: [candidate] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a Groq strict-schema validation failure safely without retrying it', async () => {
    const logs: string[] = [];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'json_validate_failed', message: 'private response body' } }), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new SafeLlmAdapter({ provider: 'groq', apiKey: 'secret-key', log: (entry) => logs.push(entry) });
    await expect(adapter.suggestLinks({ stoneText: 'private stone', candidates: [candidate] })).resolves.toEqual({ ids: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logs[0]).toContain('outcome=invalid_request status=400');
    expect(logs[0]).toContain('code=json_validate_failed');
    expect(logs[0]).not.toContain('private response body');
  });

  it.each([429, 500])('retries one retryable Groq HTTP %i within the shared deadline', async (status) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(groqPayload({ ids: ['st_a1b2c3'] })), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new SafeLlmAdapter({ provider: 'groq', apiKey: 'secret-key' });
    await expect(adapter.suggestLinks({ stoneText: 'Kevin', candidates: [candidate] })).resolves.toEqual({ ids: ['st_a1b2c3'] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses an explicit fallback model only for classified availability failures', async () => {
    const models: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      models.push((JSON.parse(String(init?.body)) as { model: string }).model);
      return models.length === 1 ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(groqPayload({ ids: ['st_a1b2c3'] })), { status: 200 });
    }));
    const adapter = new SafeLlmAdapter({ provider: 'groq', apiKey: 'secret-key', model: 'openai/gpt-oss-20b', fallbackModel: 'openai/gpt-oss-120b' });
    await expect(adapter.suggestLinks({ stoneText: 'Kevin', candidates: [candidate] })).resolves.toEqual({ ids: ['st_a1b2c3'] });
    expect(models).toEqual(['openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
  });

  it('does not cache failures or expose provider secrets', async () => {
    const logs: string[] = [];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Authorization: Bearer secret-key private prompt' } }), { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new SafeLlmAdapter({ provider: 'groq', apiKey: 'secret-key', log: (entry) => logs.push(entry) });
    await adapter.suggestLinks({ stoneText: 'private input', candidates: [candidate] });
    await adapter.suggestLinks({ stoneText: 'private input', candidates: [candidate] });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(logs.join(' ')).not.toContain('secret-key');
    expect(logs.join(' ')).not.toContain('private input');
  });

  it('coalesces simultaneous identical Groq operations before caching the success', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new SafeLlmAdapter({ provider: 'groq', apiKey: 'secret-key' });
    const input = { stoneText: 'Kevin', candidates: [candidate] };
    const first = adapter.suggestLinks(input);
    const second = adapter.suggestLinks(input);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveResponse?.(new Response(JSON.stringify(groqPayload({ ids: ['st_a1b2c3'] })), { status: 200 }));
    await expect(Promise.all([first, second])).resolves.toEqual([{ ids: ['st_a1b2c3'] }, { ids: ['st_a1b2c3'] }]);
  });

  it('cancels the request at the shared eight-second deadline', async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })));
    const adapter = new SafeLlmAdapter({ provider: 'groq', apiKey: 'secret-key', log: (entry) => logs.push(entry) });
    const request = adapter.suggestLinks({ stoneText: 'Kevin', candidates: [candidate] });
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(request).resolves.toEqual({ ids: [] });
    expect(logs[0]).toContain('provider_timeout timeout_ms=8000');
  });

  it('classifies ordinary network failures without exposing error text', async () => {
    const logs: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network failed api_key=secret-key private'); }));
    const adapter = new SafeLlmAdapter({ provider: 'groq', apiKey: 'secret-key', log: (entry) => logs.push(entry) });
    await adapter.suggestLinks({ stoneText: 'private input', candidates: [candidate] });
    expect(logs[0]).toContain('outcome=network_error');
    expect(logs[0]).not.toContain('secret-key');
    expect(logs[0]).not.toContain('private');
  });
});
