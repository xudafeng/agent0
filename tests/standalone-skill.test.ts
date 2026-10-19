import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSkillRuntime } from '../src/skills.js';

test('standalone skill roots load a repository-level SKILL.md', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-standalone-skill-'));
  await mkdir(join(root, 'references'));
  await writeFile(join(root, 'SKILL.md'), [
    '---',
    'name: radar',
    'description: Scan AI trends.',
    '---',
    '',
    '# Radar',
    '',
    'Follow the radar workflow.',
  ].join('\n'), 'utf8');
  await writeFile(join(root, 'references', 'guide.md'), 'Source rules.', 'utf8');

  const runtime = await createSkillRuntime([], [root]);
  assert.deepEqual(runtime.list().map((skill) => skill.name), ['radar']);

  await runtime.restore(['radar']);
  assert.ok(runtime.context().includes('Loaded skill radar:'));
  assert.ok(runtime.context().includes('Follow the radar workflow.'));

  const reference = await runtime.callTool({
    id: 'read-1',
    name: 'read_skill_file',
    arguments: { name: 'radar', path: 'references/guide.md' },
  }) as { content: string };
  assert.equal(reference.content, 'Source rules.');
});
