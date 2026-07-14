import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root,
  encoding: 'utf8',
}).split('\0').filter(Boolean);

const files = [];
for (const relative of listed) {
  const info = await stat(join(root, relative)).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) continue;
  if (info.isFile()) files.push(relative);
}

const forbiddenFiles = new Set([
  '.env.example',
  'schemas/supabase.sql',
  'scripts/apply-supabase-schema.sh',
  'scripts/sync-workflows.sh',
  'workflows/demo-rag-instagram-supabase.json',
  'workflows/knowledge-upload-to-supabase.json',
]);

const forbiddenText = [
  ['absolute workspace path', /\/home\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+/u],
  ['OpenAI-compatible secret', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/u],
  ['Supabase service secret', /\bsb_secret_[A-Za-z0-9_-]{12,}/u],
  ['Meta access token', /\bEA[A-Za-z0-9]{60,}/u],
  ['JWT/API token', /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/u],
  ['Telegram bot token', /\b\d{7,12}:[A-Za-z0-9_-]{25,}/u],
  ['embedded PostgreSQL password', /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@/iu],
];

const errors = [];
for (const relative of files) {
  if (forbiddenFiles.has(relative)) errors.push(`${relative}: obsolete/private-prone artifact is not allowed`);
  if (relative === 'package-lock.json') continue;
  const content = await readFile(join(root, relative), 'utf8');
  for (const [label, pattern] of forbiddenText) {
    if (pattern.test(content)) errors.push(`${relative}: ${label}`);
  }
}

const routePath = join(root, 'config/model-routes.default.json');
const routeConfig = JSON.parse(await readFile(routePath, 'utf8'));
const openai = routeConfig.routes.find((route) => route.id === 'openai_api');
if (!openai || openai.model !== 'gpt-4.1' || openai.enabled !== false) {
  errors.push('config/model-routes.default.json: OpenAI route must be disabled and use gpt-4.1');
}
const enabled = routeConfig.routes.filter((route) => route.enabled).sort((a, b) => a.priority - b.priority);
if (enabled[0]?.model !== 'gpt-5.3-codex-spark') {
  errors.push('config/model-routes.default.json: Codex Spark must be the first enabled route');
}

const workflowFiles = files.filter((file) => file.startsWith('workflows/') && file.endsWith('.json'));
if (workflowFiles.length !== 7) errors.push(`workflows: expected exactly 7 generic artifacts, found ${workflowFiles.length}`);
for (const relative of workflowFiles) {
  const artifact = JSON.parse(await readFile(join(root, relative), 'utf8'));
  if (artifact.active !== false) errors.push(`${relative}: public workflow must be inactive`);
  if (!Array.isArray(artifact.nodes) || artifact.nodes.length < 2) errors.push(`${relative}: workflow has no usable nodes`);
}

const readme = await readFile(join(root, 'README.md'), 'utf8');
for (const required of ['PostgreSQL', 'Supabase', 'replaceable', 'gpt-4.1']) {
  if (!readme.toLowerCase().includes(required.toLowerCase())) errors.push(`README.md: missing required concept ${required}`);
}

if (errors.length) {
  console.error(`Public template audit failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Public template audit passed: ${files.length} files, ${workflowFiles.length} inactive workflows, no private markers or secret-shaped values.`);
