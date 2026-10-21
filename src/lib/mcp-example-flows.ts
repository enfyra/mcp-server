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
        name: 'Scheduled flow polls records without inventing a timestamp alias',
        code: `{
  "type": "schedule",
  "config": {
    "cron": "*/5 * * * *",
    "timezone": "Asia/Ho_Chi_Minh"
  },
  "isEnabled": true
}

// In a script step, select records changed since the checkpoint:
const changed = await #orders.find({
  fields: ["id", "updatedAt", "status"],
  filter: { updatedAt: { _gte: @FLOW_PAYLOAD.since } },
  limit: 100
})`,
        notes: [
          'Schedule triggers use config.cron; the cron cadence is not represented by a table column.',
          'updatedAt is the existing system-managed last persisted-write timestamp. Use it when the requirement is “changed since T”.',
          'Do not create lastUpdated or lastModified as aliases for updatedAt.',
          'If the requirement is “successfully processed by this flow”, use a distinct lastProcessedAt/lastSuccessfulRunAt field or durable flow checkpoint because unrelated writes also advance updatedAt.',
          'This example uses placeholders; inspect the live table and use a real checkpoint source before writing the flow.',
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
          'Prefer flow_workflow for creating/updating a flow plus steps; it plans the script/condition steps before saving.',
          'Use plan_flow_steps only as a lightweight dry-run when the flow itself is not being changed.',
          'Each step should return only ids, booleans, status keys, or small counters that later steps need.',
          'When refactoring an existing flow, add or extract adjacent focused enfyra_flow_step rows instead of making an oversized sourceCode block longer.',
        ],
      },
      {
        name: 'Flow script step',
        code: `const users = await #enfyra_user.find({
  filter: { email: { _contains: '@example.com' } },
  fields: ['id', 'email'],
  limit: 50,
})
await @HELPERS.$sleep(500)
await #todo.create({ data: { title: 'Review', status: 'open' } })
return { count: users.data?.length ?? 0 }`,
        notes: [
          'Flow steps are script-only; condition steps exist only for true/false branching.',
          'Query, create, update, delete, HTTP, delay, child-flow trigger, and logging all run inside one focused script step.',
          'Use @REPOS/#table for repository access, @FETCH for HTTP, @HELPERS.$sleep for delays, @TRIGGER for child flows, and @LOGS(message, details?) for captured logs.',
        ],
      },
    ],
  };
