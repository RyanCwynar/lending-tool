import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { createPool } from "./pool.js";
import { migrate } from "./migrate.js";

// The migrations dir sits at the repo root. That's two levels up from both src/db and dist/db.
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
try {
  await migrate(pool, dir);
  console.log("migrations up to date");
} finally {
  await pool.end();
}
