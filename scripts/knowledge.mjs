import crypto from 'node:crypto';

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function chunkText(input, options = {}) {
  const maxChars = Number(options.maxChars || process.env.KB_CHUNK_SIZE || 1200);
  const overlap = Math.min(Number(options.overlap || process.env.KB_CHUNK_OVERLAP || 180), Math.floor(maxChars / 3));
  const text = String(input || '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (!text) return [];

  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  let current = '';

  const flush = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = '';
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      flush();
      let start = 0;
      while (start < paragraph.length) {
        let end = Math.min(start + maxChars, paragraph.length);
        if (end < paragraph.length) {
          const boundary = Math.max(
            paragraph.lastIndexOf('. ', end),
            paragraph.lastIndexOf('? ', end),
            paragraph.lastIndexOf('! ', end),
            paragraph.lastIndexOf(' ', end)
          );
          if (boundary > start + Math.floor(maxChars * 0.55)) end = boundary + 1;
        }
        chunks.push(paragraph.slice(start, end).trim());
        if (end >= paragraph.length) break;
        start = Math.max(end - overlap, start + 1);
      }
      continue;
    }

    const candidate = current ? current + '\n\n' + paragraph : paragraph;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    const previous = current;
    flush();
    const tail = previous.slice(Math.max(0, previous.length - overlap)).trim();
    current = (tail ? tail + '\n\n' : '') + paragraph;
    if (current.length > maxChars) {
      chunks.push(current.slice(0, maxChars).trim());
      current = current.slice(Math.max(0, maxChars - overlap)).trim();
    }
  }

  flush();
  return chunks.filter(Boolean);
}
