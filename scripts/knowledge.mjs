import { createHash } from "node:crypto";
import { replaceKnowledgeDocument } from "./db.mjs";

function splitText(text, target = 1200, overlap = 180) {
  const paragraphs = String(text || "").split(/\n\s*\n/).map((value) => value.trim()).filter(Boolean);
  const chunks = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > target) {
      chunks.push(current);
      current = `${current.slice(-overlap)}\n\n${paragraph}`;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function embeddingFor(text) {
  if (!process.env.EMBEDDING_API_URL) return null;
  const response = await fetch(process.env.EMBEDDING_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.EMBEDDING_API_KEY
        ? { Authorization: `Bearer ${process.env.EMBEDDING_API_KEY}` }
        : {})
    },
    body: JSON.stringify({
      model: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
      input: text
    }),
    signal: AbortSignal.timeout(Number(process.env.EMBEDDING_TIMEOUT_MS || 30000))
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Embedding HTTP ${response.status}`);
  const embedding = body.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length !== 1536) {
    throw new Error("Embedding endpoint must return a 1536-dimensional vector");
  }
  return embedding;
}

export async function ingestKnowledge(input) {
  if (!String(input.text || "").trim()) throw new Error("Knowledge text is required");
  const title = String(input.title || "Untitled document");
  const sourceKey = String(
    input.source_key ||
    createHash("sha256").update(`${title}\n${input.source_uri || ""}`).digest("hex")
  );
  const texts = Array.isArray(input.chunks) && input.chunks.length
    ? input.chunks.map(String)
    : splitText(
        input.text,
        Number(input.chunk_size || process.env.KB_CHUNK_SIZE || 1200),
        Number(input.chunk_overlap || process.env.KB_CHUNK_OVERLAP || 180)
      );

  const chunks = [];
  for (const content of texts) {
    let embedding = null;
    try {
      embedding = await embeddingFor(content);
    } catch (error) {
      if (process.env.EMBEDDING_REQUIRED === "true") throw error;
    }
    chunks.push({ content, embedding, metadata: input.chunk_metadata || {} });
  }

  return replaceKnowledgeDocument(
    {
      ...input,
      source_key: sourceKey,
      title,
      checksum: createHash("sha256").update(String(input.text)).digest("hex")
    },
    chunks
  );
}
