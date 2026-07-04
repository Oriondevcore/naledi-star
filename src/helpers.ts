import * as calendar from './calendar';

export type Bindings = {
  DB: D1Database;
  NALEDI_DB: D1Database;
  KARAOKE_DB: D1Database;
  MEMORY_DB: D1Database;
  AI: any;
  R2_BUCKET: R2Bucket;
  DOCS: R2Bucket;
  SELF: Fetcher;
  ASSETS: Fetcher;
  CLOUDFLARE_API_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SILICONFLOW_API_KEY?: string;
  PAYFAST_PASSPHRASE?: string;
  PAYFAST_MERCHANT_ID?: string;
  META_VERIFY_TOKEN?: string;
  META_CLOUD_API_TOKEN?: string;
  META_PHONE_NUMBER_ID?: string;
  YOCO_LIVE_SK?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  BILLING_CRON_KEY?: string;
  PAYFAST_SANDBOX?: string;
  ADMIN_AUTH_CODE?: string;
};

export type Env = Bindings & {
  GRAHAM_NUMBER?: string;
  SILICONFLOW_API_KEY?: string;
  ADMIN_AUTH_CODE?: string;
};

export const AI_MODEL = 'gpt-oss-20b';
export const CHEAP_MODEL = 'gpt-oss-20b';
export const VISION_MODEL = 'glm-4.6v-flash';
export const MEMORY_LIMIT = 10;

export const sanitizePhone = (raw: string): string =>
  raw.replace(/@c\.us$/, '').replace(/[^0-9]/g, '');

export const simulateTypingDelay = async (text: string) => {
  const wordsPerMinute = 160;
  const wordCount = text.split(/\s+/).length;
  const baseDelayMs = (wordCount / wordsPerMinute) * 60 * 1000;
  const naturalVariance = Math.random() * 1200 + 800;
  const totalDelay = Math.min(baseDelayMs + naturalVariance, 6500);
  await new Promise((resolve) => setTimeout(resolve, totalDelay));
};

export { calendar };
