export const schemaRelationsExamples = {
    title: 'Tables, columns, relations, cascade, and indexes',
    useWhen: 'Use when creating or changing persisted data models.',
    examples: [
      {
        name: 'Rich-text column with JSON-safe eApp editor configuration',
        code: `create_tables({
  globalRulesAckKey: "<globalRulesAckKey>",
  items: [{
    name: "articles",
    columns: [
      { name: "title", type: "varchar", isNullable: false },
      {
        name: "body",
        type: "richtext",
        isNullable: true,
        metadata: {
          richText: {
            plugins: ["link", "lists", "code", "table"],
            toolbar: "clear | h1 h2 h3 | bold italic underline | bullist numlist | link image table blockquote hr codeblock",
            customButtons: [
              { name: "callout", text: "Callout", tooltip: "Insert a callout", format: "callout" }
            ],
            formats: {
              callout: {
                wrapper: true,
                tag: "aside",
                classes: "callout",
                css: {
                  backgroundColor: "var(--surface-muted)",
                  borderLeft: "4px solid var(--primary-500)",
                  padding: "12px"
                }
              }
            }
          }
        }
      }
    ]
  }]
})

// The same JSON-safe configuration can be changed later.
update_columns({
  globalRulesAckKey: "<globalRulesAckKey>",
  items: [{
    tableId: "<table_id>",
    columnId: "<body_column_id>",
    metadata: { richText: { toolbar: "bold italic | link" } }
  }]
})`,
        notes: [
          'Use metadata.richText only on a column whose type is richtext.',
          'MCP accepts JSON-safe editor configuration: strings, arrays, objects, static CSS/classes/attributes, and string action names.',
          'Function callbacks and function-valued theme resolvers cannot be serialized through MCP; define those in the eApp source config instead.',
          'After a metadata write, inspect the exact table metadata and verify the column metadata before reporting the editor as configured.',
        ],
      },
      {
        name: 'Bulk schema creation with one-item-or-many arrays',
        code: `// 0. First call get_schema_design_context and get_enfyra_required_knowledge.
// 1. create_tables is always native-array-shaped. One table = one item.
create_tables({
  globalRulesAckKey: "<globalRulesAckKey>",
  items: [
    {
      name: "app_lookup",
      columns: [
        { name: "name", type: "varchar", isNullable: false },
        { name: "slug", type: "varchar", isNullable: false },
        { name: "description", type: "text", isNullable: true }
      ],
      uniques: [["slug"]]
    },
    {
      name: "app_primary_record",
      columns: [
        { name: "title", type: "varchar", isNullable: false },
        { name: "summary", type: "text", isNullable: true },
        { name: "amount", type: "float", isNullable: false, defaultValue: "0" },
        { name: "status", type: "varchar", isNullable: false, defaultValue: "draft" },
        { name: "metadata", type: "simple-json", isNullable: true }
      ],
      relations: [
        { propertyName: "lookup", type: "many-to-one", targetTable: "app_lookup", isNullable: true, onDelete: "SET NULL" },
        { propertyName: "owner", type: "many-to-one", targetTable: "enfyra_user", isNullable: false, onDelete: "CASCADE" }
      ],
      indexes: [["status", "createdAt"], ["lookup", "status"]]
    },
    {
      name: "app_participation",
      columns: [
        { name: "status", type: "varchar", isNullable: false, defaultValue: "active" },
        { name: "score", type: "float", isNullable: false, defaultValue: "0" }
      ],
      relations: [
        { propertyName: "record", type: "many-to-one", targetTable: "app_primary_record", isNullable: false, onDelete: "CASCADE" },
        { propertyName: "actor", type: "many-to-one", targetTable: "enfyra_user", isNullable: false, onDelete: "CASCADE" }
      ],
      uniques: [["record", "actor"]],
      indexes: [["status", "createdAt"]]
    }
  ]
})

// 2. create_records is also native-array-shaped. One row = one item.
create_records({
  tableName: "app_primary_record",
  globalRulesAckKey: "<globalRulesAckKey>",
  records: [
    {
      title: "<display title>",
      amount: 29.99,
      status: "active",
      lookup: "<app_lookup_id>",
      owner: "<enfyra_user_id>"
    }
  ]
})`,
        notes: [
          'All mutation tools are plural envelopes. Pass native arrays, with one item in the array for a single mutation.',
          'create_tables creates tables/columns first, then creates requested relations after all batch tables exist, so target table ordering is handled by the tool.',
          'Do not declare id, _id, createdAt, or updatedAt columns; Enfyra manages them automatically.',
          'When a unique/index group uses relation propertyName values, declare those relations in the same table item or add the constraint later with update_tables after the relations exist.',
          'Use live column types from get_schema_design_context. Prefer float for decimal-like money/ratings unless live metadata explicitly supports decimal.',
          'Do not create lookupId, owner_id, actorId, or recordIds scalar fields for normalized relationships. Use relations and write relation propertyName values.',
          'A unique pair such as record+actor already creates the indexed unique lookup; keep those fields out of indexes.',
        ],
      },
      {
        name: 'Bulk add columns and relations after initial schema',
        code: `create_columns({
  globalRulesAckKey: "<globalRulesAckKey>",
  items: [
    {
      tableId: "<enfyra_user_table_id>",
      name: "emailVerifiedAt",
      type: "datetime",
      isNullable: true,
      isPublished: true
    },
    {
      tableId: "<integration_secret_table_id>",
      name: "value",
      type: "text",
      isNullable: false,
      isPublished: false,
      isEncrypted: true
    }
  ]
})

create_relations({
  globalRulesAckKey: "<globalRulesAckKey>",
  items: [
    {
      sourceTableId: "chat_conversation",
      targetTableId: "chat_message",
      propertyName: "lastMessage",
      type: "many-to-one",
      isNullable: true,
      onDelete: "SET NULL"
    }
  ]
})`,
        notes: [
          'create_columns/create_relations run items sequentially through the schema queue.',
          'Use relation property names only. Never provide fkCol, sourceColumn, targetColumn, or junction column names.',
          'Use inversePropertyName only when a concrete parent detail/deep/count/sort use case needs the reverse traversal.',
          'Use isEncrypted=true for encryption at rest. Add isUpdatable=false separately only when the field should be immutable.',
        ],
      },
      {
        name: 'Bulk update and destructive preview',
        code: `update_tables({
  globalRulesAckKey: "<globalRulesAckKey>",
  items: [
    { tableId: "<table_id>", graphqlEnabled: true },
    { tableId: "<settings_table_id>", isSingleRecord: true }
  ]
})

update_relation_constraints({
  globalRulesAckKey: "<globalRulesAckKey>",
  items: [{ tableId: "<table_id>", relationId: "<relation_id>", onDelete: "CASCADE" }]
})

// Destructive tools preview first.
delete_columns({
  items: [{ tableId: "<table_id>", columnId: "<column_id>" }]
})

// Apply only after explicit user approval.
delete_columns({
  globalRulesAckKey: "<globalRulesAckKey>",
  confirm: true,
  items: [{ tableId: "<table_id>", columnId: "<column_id>" }]
})`,
        notes: [
          'update_tables/update_columns/update_relation_constraints/update_records reject ambiguous duplicate ids where applicable and run sequentially.',
          'update_relation_constraints changes only isNullable and/or onDelete; it preserves the full relation and table aggregate.',
          'delete_tables/delete_columns/delete_relations/delete_records return previews unless confirm=true.',
          'Schema tools serialize internally; do not parallelize schema mutation tool calls.',
        ],
      },
    ],
  };
