import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  ENTITY_TOKEN: z
    .string({ error: "ENTITY_TOKEN is missing in your .env file" })
    .min(1, "ENTITY_TOKEN is empty in your .env file")
    .refine((v) => v !== "put-your-demo-token-here", "Replace the placeholder token in .env"),
  ENTITY_REST_BASE: z.url().default("https://restapi.entitysport.com/exchange"),
  ENTITY_WS_URL: z.string().default("ws://webhook.entitysport.com:8087/connect"),
  PROVIDER_MAX_CALLS_PER_MINUTE: z.coerce.number().int().positive().default(30),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  DATABASE_URL: z.string().default("postgresql://cricket:cricket@localhost:5432/cricket"),
  SYNC_PER_PAGE: z.coerce.number().int().min(1).max(100).default(50),
  FIREBASE_DATABASE_URL: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT: z.string().optional(),
  CAPTURE_DIR: z.string().default("captures"),
  PORT: z.coerce.number().int().default(3000),
  API_HOST: z.string().default("0.0.0.0"),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(120),
  API_CORS_ORIGINS: z.string().default("*"), // comma-separated list, or * for any
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Configuration problem:");
  for (const issue of parsed.error.issues) {
    console.error(` - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;