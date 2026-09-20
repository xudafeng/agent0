import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildContext } from '../src/context.js';
import type { Message } from '../src/provider.js';
import { createSkillRuntime, skillDirectories } from '../src/skills.js';

const markdown = (name: string, body = 'Follow the review checklist.') => `---\nname: ${name}\ndescription: >-\n  Review code changes\n  for correctness.\n---\n${body}\n`;
const call = (name: string, arguments_: Record<string, unknown>) => ({ id: 'test', name, arguments: arguments_ });

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'agent0-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const add = async (directory: string, name: string, text = markdown(name)) => {
    const path = join(root, directory, name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'SKILL.md'), text);
    return path;
  };
  return { root, add };
}

test('discovers metadata, applies directory precedence, and loads body only on demand', async (t) => {
  const { root, add } = await fixture(t);
  await add('user', 'review', markdown('review', 'User instructions.'));
  const project = await add('project', 'review', markdown('review', 'Project instructions.'));
  await add('project', 'invalid', 'No frontmatter.');
  const runtime = await createSkillRuntime([join(root, 'missing'), join(root, 'user'), join(root, 'project')]);
  assert.deepEqual(runtime.list(), [{ name: 'review', description: 'Review code changes for correctness.', path: join(project, 'SKILL.md') }]);
  assert.equal(runtime.diagnostics.length, 1);
  assert.ok(!runtime.context().includes('Project instructions.'));
  await runtime.callTool(call('load_skill', { name: 'review' }));
  assert.ok(runtime.context().includes('Project instructions.'));
  assert.deepEqual(runtime.loaded(), ['review']);
  assert.ok(!runtime.context().includes('User instructions.'));
  const messages: Message[] = Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `turn ${i}` }));
  const context = buildContext('', messages, undefined, runtime.context());
  assert.equal(context.length, 5);
  assert.ok(context[0] && 'content' in context[0] && context[0].content.includes('Project instructions.'));
  const fresh = await createSkillRuntime([join(root, 'project')]);
  assert.ok(!fresh.context().includes('Project instructions.'));
  assert.deepEqual(fresh.loaded(), []);
});

test('reads supporting files only after loading and rejects escapes, binary files, and oversized files', async (t) => {
  const { root, add } = await fixture(t);
  const path = await add('skills', 'review');
  await mkdir(join(path, 'references'));
  await writeFile(join(path, 'references', 'guide.md'), 'Reference checklist.');
  await writeFile(join(root, 'secret.txt'), 'private');
  await symlink(join(root, 'secret.txt'), join(path, 'escape.txt'));
  await writeFile(join(path, 'large.txt'), 'x'.repeat(128 * 1024 + 1));
  await writeFile(join(path, 'binary.txt'), Buffer.from([0, 255]));
  const runtime = await createSkillRuntime([join(root, 'skills')]);
  const read = (file: string) => runtime.callTool(call('read_skill_file', { name: 'review', path: file }));
  await assert.rejects(read('references/guide.md'), /Load the skill/);
  await assert.rejects(runtime.callTool(call('load_skill', { name: '../secret' })), /Unknown skill/);
  await runtime.callTool(call('load_skill', { name: 'review' }));
  assert.deepEqual(await read('references/guide.md'), { name: 'review', path: 'references/guide.md', content: 'Reference checklist.' });
  for (const file of ['../../secret.txt', 'escape.txt', join(root, 'secret.txt'), 'large.txt', 'binary.txt', 'references', 'missing.txt']) {
    await assert.rejects(read(file));
  }
  await writeFile(join(path, 'SKILL.md'), markdown('renamed'));
  await assert.rejects(runtime.callTool(call('load_skill', { name: 'review' })), /name changed/);
});

test('invalid skill files are diagnosed without hiding valid neighbors', async (t) => {
  const { root, add } = await fixture(t);
  await add('skills', 'valid', markdown('valid').replaceAll('\n', '\r\n'));
  await add('skills', 'mismatch', markdown('different'));
  await add('skills', 'empty', markdown('empty', ''));
  await add('skills', 'bad-yaml', '---\nname: [\n---\nBody');
  await add('skills', 'bad-description', '---\nname: bad-description\ndescription: 123\n---\nBody');
  const runtime = await createSkillRuntime([join(root, 'skills')]);
  assert.deepEqual(runtime.list().map((skill) => skill.name), ['valid']);
  assert.equal(runtime.diagnostics.length, 4);
});

test('explicit empty configuration disables skills and custom paths require absolute paths', async () => {
  assert.deepEqual(skillDirectories({ AGENT0_SKILL_DIRS: '[]' }), []);
  assert.equal(skillDirectories({}).length, 2);
  for (const value of ['{}', '["relative"]', '[42]', 'invalid']) {
    assert.throws(() => skillDirectories({ AGENT0_SKILL_DIRS: value }));
  }
  const runtime = await createSkillRuntime([]);
  assert.deepEqual(runtime.tools, []);
  assert.equal(runtime.context(), '');
  assert.equal(runtime.hasTool('load_skill'), false);
});
