const SILICONFLOW_BASE = 'https://api.siliconflow.cn/v1/chat/completions';
const SILICONFLOW_MODELS: Record<string, string> = {
  'gpt-oss-20b': 'Qwen/Qwen2.5-7B-Instruct',
  'glm-4.6v-flash': 'THUDM/glm-4v-9b',
};
const CF_MODELS: Record<string, string> = {
  'gpt-oss-20b': '@cf/openai/gpt-oss-20b',
  'glm-4.6v-flash': '@cf/meta/llama-4-scout-17b-16e-instruct',
};
const TIMEOUT_MS = 15000;

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

async function callSiliconFlow(
  env: { SILICONFLOW_API_KEY?: string; ZAI_API_KEY?: string },
  model: string,
  options: AIOptions,
): Promise<AIResponse | null> {
  const apiKey = env.SILICONFLOW_API_KEY || env.ZAI_API_KEY;
  if (!apiKey) return null;

  const aiModel = SILICONFLOW_MODELS[model] || 'Qwen/Qwen2.5-7B-Instruct';
  const messages: any[] = options.messages || [];

  if (options.prompt && messages.length === 0) {
    messages.push({ role: 'user', content: options.prompt });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(SILICONFLOW_BASE, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: aiModel,
        messages,
        max_tokens: options.max_tokens || 1024,
        temperature: options.temperature ?? 0.7,
      }),
      signal: controller.signal,
    });

    if (!res.ok) return null;

    const data = await res.json() as any;
    return {
      response: data.choices?.[0]?.message?.content,
      choices: data.choices,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function callCF(
  env: { AI?: any },
  model: string,
  options: AIOptions,
): Promise<AIResponse> {
  const cfModel = CF_MODELS[model] || '@cf/openai/gpt-oss-20b';
  if (!env.AI?.run) throw new Error('AI binding not available');

  try {
    let result;
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
    return result;
  } catch (e: any) {
    throw new Error('Workers AI error: ' + (e?.message || String(e)));
  }
}

export async function callAI(
  env: { AI?: any; SILICONFLOW_API_KEY?: string; ZAI_API_KEY?: string },
  model: string,
  options: AIOptions,
): Promise<AIResponse> {
  const result = await callSiliconFlow(env, model, options);
  if (result) return result;
  return callCF(env, model, options);
}
