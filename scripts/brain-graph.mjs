import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Annotation, START, END, StateGraph } from '@langchain/langgraph';
import {
  beginTurn,
  retrieveKnowledge,
  finishTurn,
  recordModelFailure,
} from './db.mjs';
import { routeModelWithReview } from './model-router.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BrainState = Annotation.Root({
  input: Annotation(),
  turn: Annotation(),
  knowledge: Annotation(),
  result: Annotation(),
});

let promptCache;

async function loadPrompts() {
  if (promptCache) return promptCache;
  const shared = await fs.readFile(path.join(root, 'prompts/brain-system.md'), 'utf8');
  let privatePrompt = '';
  try {
    privatePrompt = await fs.readFile(process.env.PRIVATE_BRAIN_PROMPT || path.join(root, '.private/company-brain.md'), 'utf8');
  } catch {}
  promptCache = { shared, privatePrompt };
  return promptCache;
}

function compact(value) {
  return JSON.stringify(value ?? null, null, 2);
}

function buildRetrievalQuery(turn) {
  const summary = turn.conversation?.summary || turn.summary || '';
  const history = Array.isArray(turn.history) ? turn.history.slice(-12) : [];
  const currentMessage = turn.request?.text || '';
  const historyText = history
    .map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
    .join('\n');
  return [summary, historyText, currentMessage]
    .filter(Boolean)
    .join('\n')
    .slice(-12000);
}

function buildPrompt(prompts, turn, knowledge) {
  return [
    prompts.shared,
    prompts.privatePrompt,
    '# Current durable state',
    compact({
      conversation_summary: turn.conversation?.summary || '',
      conversation_state: turn.conversation?.semantic_state || {},
      contact_profile: turn.identity?.profile || {},
      recent_messages: turn.history || [],
      channel: turn.request?.channel,
    }),
    '# Retrieved company knowledge',
    compact(knowledge),
    '# New inbound message',
    String(turn.request?.text || ''),
    '# Turn-local response contract',
    'The newest inbound message above is authoritative for the language, register, and appropriate length of this reply. Infer response_language from that message unless the customer explicitly requests another language. Match their conversational density and lead with the shortest useful direct answer. One focused question is a ceiling, not a goal: do not ask a question when the known context already supports a useful recommendation, decision, or commitment. Retrieved knowledge, summaries, tools, and earlier messages provide facts and continuity only; they must never dictate the reply language, introduce mixed-language wording, or cause a brochure-style response. Infer intent, conversation_phase, customer_readiness, material_blocker, next_best_action, commercial_progress, decision_status, confirmed_commitments, and pending_customer_commitment from the whole conversation. Treat explicit acceptance of the immediately preceding proposal as confirmed agreement. When acceptance includes a compatible refinement, preserve the prior agreement and add the refinement; do not downgrade it to partial agreement. Keep confirmed_commitments cumulative and never reopen or reconfirm unchanged commitments. material_blocker and pending_customer_commitment must name only a genuinely unresolved customer decision that prevents progress; an optional implementation detail, repeated final confirmation, or internal planning step is not a blocker. next_best_action must describe an externally observable customer outcome, never an internal assistant activity. When readiness supports proceeding and material_blocker is empty, make a grounded recommendation or value synthesis and ask for one concrete, easy-to-answer customer commitment in this reply. When decision_status is scope_agreed or transaction_ready, move to the nearest grounded transaction action supported by available knowledge and tools: collect the minimum missing billing, contact, or kickoff detail; offer a verified booking or payment action; or obtain permission for an authorized sales handoff. The reply must execute that action now and create the stated progress. Acknowledging, recording, paraphrasing, promising to prepare something later, or asking a cosmetic or repeated question is not progress. Do not invent arbitrary scope counts, packages, capabilities, prices, payment methods, delivery promises, or implementation facts. Do not claim that planning, building, ordering, payment, or execution has begun unless the customer authorized it and the available context supports the claim. Before returning JSON, privately inspect every natural-language fragment of reply and rewrite any fragment outside response_language; translate knowledge instead of copying it in another language. Proper nouns, URLs, identifiers and code are exempt. Set reply_language_consistent to true only after that audit succeeds. Apply all judgments semantically without language-specific rules, keyword lists, fixed funnels, canned replies, or routing branches.',
    "CONSULTATIVE RUNTIME OVERRIDE (authoritative):\n- Help the customer think and decide before attempting a transaction.\n- A broad request is a discovery opportunity, not authorization for an audit, checkout, deposit, or payment.\n- Build an individualized understanding of the active workstream from the whole conversation. Give useful reasoning or a preliminary solution shape, then ask at most one high-information question when clarification is needed.\n- Never treat a short or ambiguous confirmation as acceptance when multiple services, scopes, prices, payment options, or next steps are possible.\n- A transactional commercial action is allowed only when the newest customer message explicitly and unambiguously authorizes that exact action and exact option. Otherwise continue the conversation or clarify.\n- When the customer introduces another service, preserve reusable person/company context but start a new active workstream and reset transaction readiness for it.\n- Generate each reply from evidence and context. Do not use canned sales scripts, keyword intent trees, language branches, or forced funnels.",
    'Return only the required JSON decision object.',
  ].filter(Boolean).join('\n\n');
}

async function beginNode(state) {
  const turn = await beginTurn(state.input);
  return { turn };
}

async function retrieveNode(state) {
  const escalationActive = state.turn.conversation?.status === 'escalated';
  if (state.turn.duplicate || escalationActive) {
    return { knowledge: [] };
  }
  const query = buildRetrievalQuery(state.turn);
  const knowledge = await retrieveKnowledge(
    state.turn.tenant.id,
    query,
    Number(process.env.RAG_MATCH_COUNT || 8),
  );
  return { knowledge };
}

async function thinkNode(state) {
  const escalationActive = state.turn.conversation?.status === 'escalated';
  const suppressed = state.turn.duplicate || escalationActive;
  if (suppressed) {
    return {
      result: {
        reply: state.turn.duplicate ? state.turn.priorReply?.content || '' : '',
        should_reply: false,
        should_escalate: escalationActive,
        escalation_reason: state.turn.conversation?.escalation_reason || '',
        confidence: 1,
        action: escalationActive ? 'escalate' : 'silent',
        duplicate: Boolean(state.turn.duplicate),
        conversation: state.turn.conversation,
        outbound_message: state.turn.priorReply || null,
        model_route: null,
      },
    };
  }

  const prompts = await loadPrompts();
  const prompt = buildPrompt(prompts, state.turn, state.knowledge);
      const routed = await routeModelWithReview(prompt, {
    onFailure: async (route, error, canFallback) => {
      await recordModelFailure(state.turn, {
        routeId: route.id,
        model: route.model,
        errorClass: canFallback ? 'retryable' : 'fatal',
        message: String(error?.message || error),
        retryable: canFallback,
      });
    },
  });
  const resolvedCommercialAction = routed.commercialAction || null;
  const decision = {
    ...routed.decision,
    commercial_action: resolvedCommercialAction?.valid
      ? resolvedCommercialAction.selection
      : routed.decision.commercial_action,
  };

  const result = await finishTurn(state.turn, decision, {
    routeId: routed.route.id,
    model: routed.route.model,
    provider: routed.route.provider,
    latencyMs: routed.latencyMs,
    attempts: routed.failures,
  });
  return {
    result: {
      ...result,
      commercial_action: resolvedCommercialAction,
    },
  };
}

const graph = new StateGraph(BrainState)
  .addNode('begin', beginNode)
  .addNode('retrieve', retrieveNode)
  .addNode('think', thinkNode)
  .addEdge(START, 'begin')
  .addEdge('begin', 'retrieve')
  .addEdge('retrieve', 'think')
  .addEdge('think', END)
  .compile();

export async function runBrain(input) {
  const state = await graph.invoke({ input });
  return state.result;
}
