import app from './routing';
import { processOutbox } from './cloud-api';

export default {
  fetch: app.fetch,
  async scheduled(_event: any, env: any, _ctx: any) {
    await processOutbox(env);
  },
};
