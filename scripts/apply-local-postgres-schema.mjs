import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "./db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sql = await readFile(path.join(root, "schemas", "local-postgres-brain.sql"), "utf8");
await getPool().query(sql);
process.stdout.write("Local PostgreSQL schema applied.\n");
await getPool().end();
