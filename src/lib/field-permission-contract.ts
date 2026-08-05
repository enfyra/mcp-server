const OPERATORS = new Set([
  '_eq', '_neq', '_gt', '_gte', '_lt', '_lte', '_in', '_not_in', '_nin',
  '_is_null', '_is_not_null',
]);

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateNode(node: unknown, path: string, errors: string[]): void {
  if (!isObject(node)) {
    errors.push(`${path || 'condition'} must be an object`);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    const current = path ? `${path}.${key}` : key;
    if (key === '_and' || key === '_or') {
      if (!Array.isArray(value) || value.length === 0) {
        errors.push(`${current} must be a non-empty array`);
        continue;
      }
      value.forEach((child, index) => validateNode(child, `${current}.${index}`, errors));
      continue;
    }
    if (key === '_not') {
      validateNode(value, current, errors);
      continue;
    }
    if (key.startsWith('_')) {
      errors.push(`${current} operator is not supported`);
      continue;
    }
    if (!isObject(value)) {
      errors.push(`${current} must be an operator object`);
      continue;
    }
    const operatorKeys = Object.keys(value);
    const isOperatorNode = operatorKeys.length > 0 && operatorKeys.every((operator) => operator.startsWith('_'));
    if (!isOperatorNode) {
      validateNode(value, current, errors);
      continue;
    }
    for (const operator of operatorKeys) {
      const operatorPath = `${current}.${operator}`;
      if (!OPERATORS.has(operator)) {
        errors.push(`${operatorPath} operator is not supported`);
        continue;
      }
      const operand = value[operator];
      if (['_in', '_not_in', '_nin'].includes(operator) && !Array.isArray(operand) && typeof operand !== 'string') {
        errors.push(`${operatorPath} must be an array or user macro`);
      }
      if (typeof operand === 'string' && operand.startsWith('@USER.') && !['@USER.id', '@USER._id'].includes(operand)) {
        errors.push(`${operatorPath} macro is not supported`);
      }
    }
  }
}

export function validateFieldPermissionCondition(condition: unknown): { ok: true } | { ok: false; errors: string[] } {
  if (condition == null) return { ok: true };
  const errors: string[] = [];
  validateNode(condition, '', errors);
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

export function canonicalFieldPermissionCondition(condition: unknown): string {
  if (typeof condition === 'string') {
    try { return canonicalFieldPermissionCondition(JSON.parse(condition)); } catch { return condition; }
  }
  if (Array.isArray(condition)) return `[${condition.map(canonicalFieldPermissionCondition).sort().join(',')}]`;
  if (!isObject(condition)) return JSON.stringify(condition ?? null);
  return `{${Object.keys(condition).sort().map((key) => `${JSON.stringify(key)}:${canonicalFieldPermissionCondition(condition[key])}`).join(',')}}`;
}
