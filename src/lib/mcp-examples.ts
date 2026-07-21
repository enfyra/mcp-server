import { connectExamples } from './mcp-example-connect.js';
import { oauthSetupExamples } from './mcp-example-oauth-setup.js';
import { schemaRelationsExamples } from './mcp-example-schema-relations.js';
import { queriesDeepExamples } from './mcp-example-queries-deep.js';
import { graphqlExamples } from './mcp-example-graphql.js';
import { handlersHooksExamples } from './mcp-example-handlers-hooks.js';
import { permissionsRlsExamples } from './mcp-example-permissions-rls.js';
import { websocketExamples } from './mcp-example-websocket.js';
import { flowsExamples } from './mcp-example-flows.js';
import { filesExamples } from './mcp-example-files.js';
import { extensionsExamples } from './mcp-example-extensions.js';

export const EXAMPLE_REASONING_GUIDE = [
  'Examples are reasoning anchors, not templates to copy blindly. Preserve the platform contract, then adapt table names, route paths, relation names, fields, UI labels, and lifecycle triggers to the live app.',
  'First identify the invariant being demonstrated: security boundary, query shape, shell registry contract, schema relation direction, runtime lifecycle, or browser proxy pattern.',
  'Then identify what is illustrative: chat/order/report/cloud paths, sample field names, icons, labels, menu order, and specific notification kinds.',
  'When a note says do not, treat it as a contract or safety boundary unless live metadata proves a different supported contract. When a note says for example, map the idea to the current domain instead of copying the literal names.',
  'Before applying an example, inspect live metadata/routes/features and choose the closest supported tool. Use the smallest example that proves the decision, then compose with other examples only when the task truly needs multiple contracts.',
];

export const EXAMPLE_CATEGORIES = {
  "connect": connectExamples,
  "oauth-setup": oauthSetupExamples,
  "schema-relations": schemaRelationsExamples,
  "queries-deep": queriesDeepExamples,
  "graphql": graphqlExamples,
  "handlers-hooks": handlersHooksExamples,
  "permissions-rls": permissionsRlsExamples,
  "websocket": websocketExamples,
  "flows": flowsExamples,
  "files": filesExamples,
  "extensions": extensionsExamples,
};

export function listExampleCategories() {
  return Object.entries(EXAMPLE_CATEGORIES).map(([key, value]) => ({
    key,
    title: value.title,
    useWhen: value.useWhen,
  }));
}

export function getExamples(category) {
  if (!category) {
    return {
      reasoningGuide: EXAMPLE_REASONING_GUIDE,
      categories: listExampleCategories(),
      hint: 'Call get_enfyra_examples with one category key to retrieve concrete examples for that area.',
    };
  }

  const entry = EXAMPLE_CATEGORIES[category];
  if (!entry) {
    return {
      error: `Unknown example category "${category}"`,
      categories: listExampleCategories(),
    };
  }

  return {
    category,
    reasoningGuide: EXAMPLE_REASONING_GUIDE,
    ...entry,
  };
}
