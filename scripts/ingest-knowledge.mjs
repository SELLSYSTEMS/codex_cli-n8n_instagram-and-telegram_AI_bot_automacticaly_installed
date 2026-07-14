import { readFile } from "node:fs/promises";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
}

const file = option("file");
if (!file) throw new Error("Usage: npm run knowledge:ingest -- --file PATH [--title TITLE] [--source-key KEY]");
const body = {
  tenant_slug: option("tenant") || "default",
  title: option("title") || file,
  source_key: option("source-key") || file,
  source_uri: option("source-uri") || null,
  text: await readFile(file, "utf8")
};
const base = process.env.BRAIN_API_URL || "http://127.0.0.1:8789";
const response = await fetch(`${base}/v1/knowledge`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(process.env.BRAIN_ADMIN_TOKEN
      ? { Authorization: `Bearer ${process.env.BRAIN_ADMIN_TOKEN}` }
      : {})
  },
  body: JSON.stringify(body)
});
const result = await response.json();
if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
