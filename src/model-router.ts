import { callAI } from './ai-provider';

export const CLASSIFIER_MODEL = 'gpt-oss-20b';

export type Complexity = 'simple' | 'complex';

export async function classifyComplexity(
  env: { SILICONFLOW_API_KEY?: string; ZAI_API_KEY?: string; AI?: any },
  body: string,
): Promise<Complexity> {
  try {
    const result = await callAI(env, CLASSIFIER_MODEL, {
      prompt: `Classify this WhatsApp message as "simple" or "complex".

Simple = greetings, name exchange, thanks, short answers, basic info requests, casual chat.
Complex = bookings, scheduling, job applications, detailed enquiries, multi-step requests, pricing discussions, document handling, business reviews.

Message: "${body.slice(0, 500)}"

Return exactly one word: simple or complex.`
    });
    const response = (result.response || '').trim().toLowerCase();
    return response.includes('complex') ? 'complex' : 'simple';
  } catch {
    return 'complex';
  }
}
