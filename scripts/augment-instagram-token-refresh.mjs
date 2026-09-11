import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedDirectory = path.join(root, 'workflows', 'generated');
const workflowName = 'Channel - Instagram - Shared AI Brain';

const managedNodeNames = new Set([
  'Instagram Token Lifecycle',
  'Refresh Instagram Token Weekly',
  'Load Instagram Token For Refresh',
  'Refresh Instagram Long-Lived Token',
  'Store Refreshed Instagram Token',
  'Load Current Instagram Token',
]);

const bootstrapCode = `const state = $getWorkflowStaticData('global');
const bootstrapToken = '__IG_ACCESS_TOKEN__';

if (!bootstrapToken || bootstrapToken.startsWith('__')) {
  throw new Error('IG_ACCESS_TOKEN was not materialized during deployment');
}

const bootstrapFingerprint = bootstrapToken.length + ':' + bootstrapToken.slice(-16);
if (!state.instagramAccessToken || state.instagramBootstrapFingerprint !== bootstrapFingerprint) {
  state.instagramAccessToken = bootstrapToken;
  state.instagramBootstrapFingerprint = bootstrapFingerprint;
  state.instagramTokenSource = 'deployment-bootstrap';
  state.instagramTokenUpdatedAt = new Date().toISOString();
  delete state.instagramTokenExpiresAt;
}

const input = $input.first()?.json ?? {};
return [{ json: { ...input, _igAccessToken: state.instagramAccessToken } }];`;

const storeCode = `const response = $input.first()?.json ?? {};
if (!response.access_token) {
  throw new Error('Instagram token refresh returned no access_token');
}

const state = $getWorkflowStaticData('global');
const expiresIn = Number(response.expires_in || 0);
const refreshedAt = new Date();

state.instagramAccessToken = response.access_token;
state.instagramTokenSource = 'scheduled-refresh';
state.instagramTokenUpdatedAt = refreshedAt.toISOString();
state.instagramTokenExpiresAt = expiresIn > 0
  ? new Date(refreshedAt.getTime() + expiresIn * 1000).toISOString()
  : null;

return [{
  json: {
    refreshed: true,
    token_type: response.token_type || 'bearer',
    expires_in: expiresIn || null,
    refreshed_at: state.instagramTokenUpdatedAt,
    expires_at: state.instagramTokenExpiresAt,
  },
}];`;

function node({ id, name, type, typeVersion, position, parameters }) {
  return { id, name, type, typeVersion, position, parameters };
}

function removeManagedNodes(workflow) {
  workflow.nodes = workflow.nodes.filter((item) => !managedNodeNames.has(item.name));
  workflow.connections ||= {};

  for (const name of managedNodeNames) delete workflow.connections[name];

  for (const source of Object.keys(workflow.connections)) {
    const outputs = workflow.connections[source];
    for (const type of Object.keys(outputs)) {
      outputs[type] = outputs[type].map((connections) =>
        (connections || []).filter((connection) => !managedNodeNames.has(connection.node)),
      );
    }
  }
}

function connect(workflow, source, target) {
  workflow.connections[source] = {
    main: [[{ node: target, type: 'main', index: 0 }]],
  };
}

function installTokenLifecycle(workflow) {
  removeManagedNodes(workflow);

const prepare = workflow.nodes.find((item) => item.name === 'Deliver only when brain approves');
  const send = workflow.nodes.find((item) => item.name === 'Send Instagram reply');
  if (!prepare || !send) {
    throw new Error('Instagram delivery nodes were not found in generated workflow');
  }

  send.parameters ||= {};
  send.parameters.sendHeaders = true;
  send.parameters.headerParameters ||= { parameters: [] };
  send.parameters.headerParameters.parameters ||= [];
  const headers = send.parameters.headerParameters.parameters;
  const authorization = headers.find((header) => header.name?.toLowerCase() === 'authorization');
  const dynamicAuthorization = "={{ 'Bearer ' + $json._igAccessToken }}";
  if (authorization) authorization.value = dynamicAuthorization;
  else headers.push({ name: 'Authorization', value: dynamicAuthorization });

  const [prepareX, prepareY] = prepare.position;
  const [sendX, sendY] = send.position;
  const loadCurrentX = Math.round((prepareX + sendX) / 2);
  const refreshY = Math.max(prepareY, sendY) + 520;

  workflow.nodes.push(
    node({
      id: 'f4685524-a6ed-4ba7-b636-aa02336a7761',
      name: 'Instagram Token Lifecycle',
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [prepareX - 300, refreshY - 180],
      parameters: {
        width: 1320,
        height: 360,
        content: '## Instagram access-token lifecycle\nThe active workflow renews the long-lived Instagram Login token every week and stores the latest token in workflow static data. `.env` is the bootstrap and emergency re-authorization source only. A Meta token is renewable, not literally immortal: revocation, password/security changes, or lost permissions still require a new login token followed by deployment.',
      },
    }),
    node({
      id: 'd7a1c725-dcf8-4ddd-b4f9-6d4d785b6350',
      name: 'Refresh Instagram Token Weekly',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [prepareX - 180, refreshY],
      parameters: {
        rule: {
          interval: [{
            field: 'weeks',
            weeksInterval: 1,
            triggerAtDay: [0],
            triggerAtHour: 3,
            triggerAtMinute: 17,
          }],
        },
      },
    }),
    node({
      id: '9ac81ad5-ee41-4cb4-a839-1cd939fe5349',
      name: 'Load Instagram Token For Refresh',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [prepareX + 80, refreshY],
      parameters: { jsCode: bootstrapCode },
    }),
    node({
      id: '349470d5-120d-4a16-b2ae-91de0987cebf',
      name: 'Refresh Instagram Long-Lived Token',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [prepareX + 360, refreshY],
      parameters: {
        url: 'https://graph.instagram.com/refresh_access_token',
        sendQuery: true,
        queryParameters: {
          parameters: [
            { name: 'grant_type', value: 'ig_refresh_token' },
            { name: 'access_token', value: '={{ $json._igAccessToken }}' },
          ],
        },
        options: {},
      },
    }),
    node({
      id: '2772f172-89c4-4f25-87e1-a2d08064c777',
      name: 'Store Refreshed Instagram Token',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [prepareX + 660, refreshY],
      parameters: { jsCode: storeCode },
    }),
    node({
      id: '11a87a06-e075-4340-938d-ee5004051411',
      name: 'Load Current Instagram Token',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [loadCurrentX, prepareY],
      parameters: { jsCode: bootstrapCode },
    }),
  );

connect(workflow, 'Deliver only when brain approves', 'Load Current Instagram Token');
  connect(workflow, 'Load Current Instagram Token', 'Send Instagram reply');
  connect(workflow, 'Refresh Instagram Token Weekly', 'Load Instagram Token For Refresh');
  connect(workflow, 'Load Instagram Token For Refresh', 'Refresh Instagram Long-Lived Token');
  connect(workflow, 'Refresh Instagram Long-Lived Token', 'Store Refreshed Instagram Token');
}

const files = (await readdir(generatedDirectory)).filter((file) => file.endsWith('.json'));
let updatedPath = null;

for (const file of files) {
  const filePath = path.join(generatedDirectory, file);
  const workflow = JSON.parse(await readFile(filePath, 'utf8'));
  if (workflow.name !== workflowName) continue;

  installTokenLifecycle(workflow);
  await writeFile(filePath, `${JSON.stringify(workflow, null, 2)}\n`, 'utf8');
  updatedPath = filePath;
  break;
}

if (!updatedPath) throw new Error(`Generated workflow not found: ${workflowName}`);
console.log(`Installed Instagram token lifecycle in ${path.relative(root, updatedPath)}`);
