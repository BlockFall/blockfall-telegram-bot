import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required'),
  ADMIN_GROUP_ID: z.coerce.number().int().refine((n) => n < 0, {
    message: 'ADMIN_GROUP_ID must be the negative supergroup ID (e.g. -1001234567890)',
  }),
  DATA_FILE: z.string().default('data/customers.json'),
  WELCOME_MESSAGE: z
    .string()
    .default(
      "Hi! You're now connected to our support team. Send us a message and we'll get back to you as soon as possible."
    ),
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(z.treeifyError(parsed.error));
  process.exit(1);
}

const config = parsed.data;

export type Config = typeof config;
export default config;
