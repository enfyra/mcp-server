# Project-local script mirror and LLM guidance

## Problem

When the model inspects a live dynamic script, the MCP writes the source to
`SOURCE_ARTIFACT_DIR = join(tmpdir(), 'enfyra-mcp-sources', String(process.pid))`
(`src/lib/source-artifacts.ts`). On macOS that resolves to a path such as
`/var/folders/fk/<hash>/T/enfyra-mcp-sources/<pid>/<table>-<id>-<field>-<hash>.js`.

Consequences:

- The path is ephemeral (OS temp, per-process, PID-keyed) and cannot be guessed or
  scripted against.
- It is outside the project, so the working copy is not greppable, diffable, or
  reviewable alongside the code that calls it.
- `sourceFile` writes only accept paths the MCP itself created
  (`readSourceArtifactFile` resolves through the in-memory `SOURCE_ARTIFACTS` map),
  so the model cannot point a write at a file it authored in the project.

## Root cause

The server has no notion of a project root. It reads only `ENFYRA_API_URL`,
`ENFYRA_API_TOKEN`, `ENFYRA_APP_URL`, and the `ENFYRA_MCP_*` runtime keys. The stdio
server's `process.cwd()` is chosen by whichever host launched it, so it is not a
reliable project anchor. Any project-local placement requires an explicit root.

Precedent for a configurable directory already exists:

- `ENFYRA_MCP_USAGE_DIR || '/tmp/enfyra-mcp-usage'`
- `ENFYRA_MCP_BENCHMARK_DIR || '/tmp/enfyra-mcp-benchmark'`

## Proposal

### 1. Project root awareness (prerequisite)

Add `ENFYRA_MCP_PROJECT_ROOT`. The `config` CLI sets it to the directory it ran in,
because that is the only point where the project is unambiguous. Fallback remains
`process.cwd()`.

Without this step nothing else can be project-local, so it gates the rest.

### 2. Relocate the artifact directory

When a project root is known:

```
<projectRoot>/.enfyra/tmp/sources/
```

Otherwise keep today's OS-temp behavior unchanged. `config` adds `.enfyra/` to the
project `.gitignore` through the existing `ensureProjectConfigIgnored`, which already
appends relative paths safely and pairs with `assertProjectConfigUntracked` (which
refuses to write tracked files). `cleanup` already removes the artifact directory and
continues to work.

This alone answers "where is `.tmp`" and makes the model's working files inspectable.

### 3. Mirror convention

`<projectRoot>/enfyra/` mirrors live dynamic scripts, one subfolder per artifact kind:

```
enfyra/
  route-handler/<slug>.js
  flow-step/<slug>.js
  extension/<slug>.vue
```

Filenames derive from table, record id, and field, with one stable semantic key and no
version labels, matching the repository key-naming rule.

Sync discipline, stated in guidance:

- Mirror absent: pull the live artifact before editing it.
- Mirror present: treat it as the working copy and reconcile against the server before
  and after edits.
- Never silently overwrite a divergent local file; report the difference and let the
  caller decide.

### 4. `sourceFile` containment

To make the mirror usable for writes, `sourceFile` must accept project-relative paths,
restricted to the project root: reject `..` escapes and symlink escapes, and resolve
the real path before reading. Today it accepts only MCP-created artifacts.

### 5. Optional tool

One narrow tool is worth adding: `sync_project_scripts` with an explicit direction
(`pull` or `status`). `status` reports drift per mirrored artifact; `pull` writes only
missing files and reports conflicts instead of overwriting. No implicit full sync.

## Security note

A committed mirror contains live script source. Some live scripts embed credentials or
internal hostnames, and the MCP does not scrub source on read. Guidance must require
reviewing the mirror before committing it, and `enfyra/` should stay out of version
control unless the project deliberately wants a reviewed snapshot.

## Recommendation on the worktree tool

Do not add a git/worktree tool to the MCP surface.

- The server does not know the project root (see above), so a worktree tool would guess
  its target from a host-dependent `process.cwd()`.
- The model-invocable surface is deliberately HTTP-only. Local repository mutation lives
  in the human-invoked `config` and `cleanup` subcommands. A model-invocable command that
  runs `git worktree add` and edits `.gitignore` in the user's repository is an
  escalation of that boundary, and the existing `assertProjectConfigUntracked` shows the
  authors already treat local repo writes as sensitive.
- Worktree and ignore hygiene are generic coding-agent concerns with native host support.
  Duplicating them here adds version coupling for no domain value.
- Note also that a worktree is normally placed outside the main working tree, so
  gitignoring it is usually unnecessary; it only matters if the worktree is nested inside
  the repository.

If a helper is genuinely wanted later, it belongs in the `config` CLI alongside the
existing gitignore logic, not in the MCP tool catalog.

Guidance is enough for the worktree rule: state the convention and let the host's own
tooling perform it.
