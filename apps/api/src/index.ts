import { existsSync } from "node:fs";
import path from "node:path";

// Load the repo-root .env (pnpm runs this from apps/api) before anything reads process.env.
for (const candidate of [".env", "../../.env"]) {
  const file = path.resolve(process.cwd(), candidate);
  if (existsSync(file)) {
    process.loadEnvFile(file);
    break;
  }
}

const { default: app } = await import("./app");
const { logger } = await import("./lib/logger");

const port = Number(process.env["PORT"] ?? 8080);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${process.env["PORT"]}"`);
}

if (!process.env.TMDB_READ_ACCESS_TOKEN && !process.env.TMDB_API_KEY) {
  logger.warn("No TMDB credentials: set TMDB_READ_ACCESS_TOKEN in .env (see .env.example)");
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Muse API listening");
});
