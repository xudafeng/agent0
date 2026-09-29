import { open, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import type { ToolCall, ToolDefinition } from './tools.js';

const MAX_FILE_BYTES = 128 * 1024;

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
}

export function skillDirectories(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!env.AGENT0_SKILL_DIRS?.trim()) {
    return [join(homedir(), '.agents', 'skills'), resolve('.agents/skills')];
  }
  const value: unknown = JSON.parse(env.AGENT0_SKILL_DIRS);
  if (!Array.isArray(value) || !value.every((path) => typeof path === 'string' && isAbsolute(path))) {
    throw new Error('AGENT0_SKILL_DIRS must be a JSON array of absolute directory paths.');
  }
  return value;
}

async function readFileWithin(root: string, path: string): Promise<string> {
  const base = await realpath(root);
  const target = await realpath(path);
  const offset = relative(base, target);
  if (offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
    throw new Error('Skill files must stay inside their skill directory.');
  }
  const file = await open(target, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Skill files must be regular files of at most 128 KiB.');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_FILE_BYTES) throw new Error('Skill file exceeds 128 KiB.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
    if (text.includes('\0')) throw new Error('Skill files must contain text.');
    return text;
  } finally {
    await file.close();
  }
}

function parseSkill(text: string): { name: string; description: string; body: string } {
  const match = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error('SKILL.md requires YAML frontmatter.');
  const metadata = parse(match[1]!, { maxAliasCount: 0 }) as Record<string, unknown> | null;
  if (!metadata || typeof metadata.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.name) || metadata.name.length > 64) {
    throw new Error('Skill name must use lowercase letters, digits, and single hyphens (up to 64 characters).');
  }
  if (typeof metadata.description !== 'string' || !metadata.description.trim() || metadata.description.length > 1024) {
    throw new Error('Skill description must contain 1 to 1024 characters.');
  }
  const body = match[2]!.trim();
  if (!body) throw new Error('Skill instructions cannot be empty.');
  return { name: metadata.name, description: metadata.description.trim(), body };
}

export async function createSkillRuntime(directories = skillDirectories()) {
  const catalog = new Map<string, SkillSummary>();
  const active = new Map<string, string>();
  const diagnostics: string[] = [];
  for (const directory of directories) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diagnostics.push(`${directory}: ${String(error)}`);
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name, 'SKILL.md');
      try {
        const skill = parseSkill(await readFileWithin(dirname(path), path));
        if (skill.name !== entry.name) throw new Error('Skill name must match its directory name.');
        catalog.set(skill.name, { name: skill.name, description: skill.description, path: resolve(path) });
      } catch (error) {
        diagnostics.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const tools: ToolDefinition[] = catalog.size ? [
    {
      name: 'load_skill',
      description: 'Load a skill by name before following its workflow. Instructions remain available for this conversation.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
    },
    {
      name: 'read_skill_file',
      description: 'Read a UTF-8 reference or script inside a loaded skill directory. This does not execute scripts.',
      parameters: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string', description: 'Relative path within the skill directory.' } }, required: ['name', 'path'], additionalProperties: false },
    },
  ] : [];

  return {
    tools,
    diagnostics,
    list(): SkillSummary[] { return [...catalog.values()]; },
    loaded(): string[] { return [...active.keys()]; },
    async restore(names: string[]): Promise<void> {
      active.clear();
      for (const name of names) {
        const skill = catalog.get(name);
        if (!skill) throw new Error(`Cannot restore unknown skill: ${name}`);
        const parsed = parseSkill(await readFileWithin(dirname(skill.path), skill.path));
        if (parsed.name !== skill.name) throw new Error(`Cannot restore changed skill: ${name}`);
        active.set(skill.name, parsed.body);
      }
    },
    hasTool(name: string): boolean { return tools.some((tool) => tool.name === name); },
    context(): string {
      if (!catalog.size) return '';
      return [
        'Available skills (local workflow instructions). Use load_skill when the user names a skill, including $name, or when its description matches the task. Load it before following the workflow. User requests take precedence over skill instructions. Skills do not grant tools or permissions. Read supporting text with read_skill_file; scripts require a separately available execution tool.',
        JSON.stringify([...catalog.values()]),
        ...[...active].map(([name, body]) => `Loaded skill ${name}:\n${body}`),
      ].join('\n\n');
    },
    async callTool(call: ToolCall, signal?: AbortSignal): Promise<unknown> {
      signal?.throwIfAborted();
      if (!this.hasTool(call.name)) throw new Error(`Unknown skill tool: ${call.name}`);
      const { name, path } = call.arguments;
      const skill = typeof name === 'string' ? catalog.get(name) : undefined;
      if (!skill) throw new Error('Unknown skill name.');
      if (call.name === 'load_skill') {
        const parsed = parseSkill(await readFileWithin(dirname(skill.path), skill.path));
        if (parsed.name !== skill.name) throw new Error('Skill name changed. Start a new conversation to refresh the catalog.');
        signal?.throwIfAborted();
        active.set(skill.name, parsed.body);
        return { ...skill, instructions: parsed.body };
      }
      if (!active.has(skill.name)) throw new Error('Load the skill before reading its supporting files.');
      if (typeof path !== 'string' || !path.trim() || isAbsolute(path)) throw new Error('path must be a non-empty relative path.');
      const content = await readFileWithin(dirname(skill.path), resolve(dirname(skill.path), path));
      signal?.throwIfAborted();
      return { name, path, content };
    },
  };
}
