export const flowsExamples = {
    title: 'Flows and step scripts',
    useWhen: 'Use when automating background work or chaining steps.',
    examples: [
      {
        name: 'Manual flow trigger from a post-hook',
        code: `if (!@ERROR && @DATA?.data?.[0]) {
  await @TRIGGER("send-welcome-email", {
    userId: @DATA.data[0].id,
    email: @DATA.data[0].email
  })
}`,
        notes: [
          'Use flows for workflow semantics, retries, and history.',
          'Do not use a flow just to persist a normal chat message.',
        ],
      },
      {
        name: 'Flow condition step',
        code: `const order = @FLOW_PAYLOAD.order
return order && order.total > 1000`,
        notes: [
          'Condition steps use JavaScript truthy/falsy.',
          'Children run according to branch true/false.',
        ],
      },
      {
        name: 'Split a provisioning workflow into focused steps',
        code: `[
  { "key": "load_project", "stepOrder": 10, "type": "query" },
  { "key": "reserve_capacity", "stepOrder": 20, "type": "script" },
  { "key": "create_database_user", "stepOrder": 30, "type": "http" },
  { "key": "apply_database_guardrails", "stepOrder": 40, "type": "script" },
  { "key": "start_container", "stepOrder": 50, "type": "http" },
  { "key": "check_health", "stepOrder": 60, "type": "http" },
  { "key": "finalize_project", "stepOrder": 70, "type": "update" },
  { "key": "write_audit_log", "stepOrder": 80, "type": "log" }
]`,
        notes: [
          'Prefer flow_workflow for creating/updating a flow plus steps; it plans fixed step types before saving.',
          'Use plan_flow_steps only as a lightweight dry-run when the flow itself is not being changed.',
          'Each step should return only ids, booleans, status keys, or small counters that later steps need.',
          'When refactoring an existing flow, add or extract adjacent focused enfyra_flow_step rows instead of making an oversized sourceCode block longer.',
        ],
      },
      {
        name: 'Flow query step config',
        code: `{
  "table": "enfyra_user",
  "filter": { "email": { "_contains": "@example.com" } },
  "limit": 50
}`,
        notes: [
          'Step configs are JSON; script steps use code strings.',
          'Use public-safe URLs for HTTP steps.',
        ],
      },
      {
        name: 'Flow create/update/delete step configs',
        code: `// ensure_create_flow_step
{ "table": "todo", "data": { "title": "Review", "status": "open" } }

// ensure_update_flow_step
{ "table": "todo", "id": "fixed-todo-id", "data": { "status": "done" } }

// ensure_delete_flow_step
{ "table": "todo", "id": "fixed-todo-id" }`,
        notes: [
          'Use fixed CRUD flow step tools only for static config; ESV does not interpolate @FLOW_PAYLOAD, @FLOW_LAST, or @FLOW inside fixed-step config.',
          'Use one focused script step when a record id or body comes from runtime flow values, when a step coordinates multiple records, computes complex data, or calls packages.',
          'Inside a script step, write captured logs with @LOGS(message, details?), not @LOGS.info().',
        ],
      },
    ],
  };
