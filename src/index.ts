import { startBot } from './bot.ts';

startBot().catch((err: unknown) => {
  console.error('[bot] fatal error:', err);
  process.exit(1);
});
