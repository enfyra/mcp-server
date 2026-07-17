import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SKILLS = [
  'enfyra-mcp-core',
  'enfyra-mcp-schema-data',
  'enfyra-mcp-dynamic-code',
  'enfyra-mcp-extension-ui',
  'enfyra-mcp-runtime-surfaces',
  'enfyra-mcp-config-release',
  'enfyra-mcp-performance',
];

test('README stays focused on install and configuration', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /## Install and Configure/);
  assert.match(readme, /## Manual Configuration/);
  assert.match(readme, /## Environment/);
  assert.doesNotMatch(readme, /## Model Tiers|\| T[0-3] \||recommended tier|Current recommendation status/i);
  assert.doesNotMatch(readme, /GPT-5\.6 Terra|Claude Opus|DeepSeek V4|GLM-5 Turbo/);
  assert.doesNotMatch(readme, /## Runtime Safety|## Query Notes|## Tool Summary|## Metadata Contract/);
});

test('every MCP domain skill has trigger metadata and no scaffold placeholders', () => {
  for (const name of SKILLS) {
    const skill = readFileSync(new URL(`../.codex/skills/${name}/SKILL.md`, import.meta.url), 'utf8');
    assert.match(skill, new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---`, 's'));
    assert.doesNotMatch(skill, /\[TODO|TODO:/);
  }
});
