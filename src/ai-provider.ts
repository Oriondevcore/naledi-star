const CF_MODELS: Record<string, string> = {
  'kimi-k2.6': '@cf/moonshotai/kimi-k2.6',
  'llama-4-scout': '@cf/meta/llama-4-scout-17b-16e-instruct',
}; // VISION_MODEL also uses 'llama-4-scout' — same model handles multimodal

const MODEL_COST_PER_M: Record<string, { input: number; output: number }> = {
  '@cf/meta/llama-4-scout-17b-16e-instruct': { input: 0.27, output: 0.85 },
  '@cf/moonshotai/kimi-k2.6': { input: 0.95, output: 4.00 },
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { input: 0.90, output: 0.90 },
  '@cf/openai/whisper-large-v3-turbo': { input: 0, output: 0 }, // STT via Workers AI included in plan
};

interface AIOptions {
  messages?: any[];
  prompt?: string;
  max_tokens?: number;
  temperature?: number;
}

interface AIResponse {
  response?: string;
  choices?: { message: { content: string } }[];
}

export function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  const rate = MODEL_COST_PER_M[model] || MODEL_COST_PER_M['@cf/meta/llama-4-scout-17b-16e-instruct'];
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

async function logUsage(env: any, model: string, inputTokens: number, outputTokens: number) {
  if (!env.NALEDI_DB) return;
  const costUsd = calcCost(model, inputTokens, outputTokens);
  try {
    await env.NALEDI_DB.prepare(
      `CREATE TABLE IF NOT EXISTS ai_usage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )`
    ).run();
    await env.NALEDI_DB.prepare(
      'INSERT INTO ai_usage_log (model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?)'
    ).bind(model, inputTokens, outputTokens, costUsd).run();
  } catch {}
}

export async function callAI(
  env: { AI?: any; NALEDI_DB?: any },
  model: string,
  options: AIOptions,
): Promise<AIResponse> {
  const cfModel = CF_MODELS[model] || '@cf/meta/llama-4-scout-17b-16e-instruct';
  if (!env.AI?.run) throw new Error('AI binding not available');

  try {
    let result: any;
    if (options.messages) {
      result = await env.AI.run(cfModel, {
        messages: options.messages,
        max_tokens: options.max_tokens || 1024,
      });
    } else {
      result = await env.AI.run(cfModel, {
        prompt: options.prompt,
        max_tokens: options.max_tokens || 1024,
      });
    }

    const usage = result?.usage;
    const inputTokens = usage?.input_tokens || 0;
    const outputTokens = usage?.output_tokens || 0;
    if (inputTokens || outputTokens) {
      logUsage(env, cfModel, inputTokens, outputTokens);
    }

    return result;
  } catch (e: any) {
    throw new Error('Workers AI error: ' + (e?.message || String(e)));
  }
}
