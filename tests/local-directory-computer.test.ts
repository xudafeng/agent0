import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalDirectoryComputer } from '../src/local-computer.js';

test('external local computer uses an existing directory without copying it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-external-computer-'));
  await writeFile(join(root, 'input.txt'), 'hello', 'utf8');

  const computer = await createLocalDirectoryComputer(root);
  assert.equal(computer.ref.backend, 'local-directory');
  assert.equal(await computer.readTextFile('input.txt'), 'hello');

  await computer.writeTextFile('nested/output.txt', 'done');
  assert.equal(await readFile(join(root, 'nested', 'output.txt'), 'utf8'), 'done');

  const result = await computer.exec({
    command: process.execPath,
    args: ['-e', 'process.stdout.write(process.cwd())'],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, root);

  await assert.rejects(computer.readTextFile('../outside.txt'), /escapes the workspace/);
  await computer.destroy();
});

test('external local computer derives a stable reference from its real path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-external-computer-'));
  const first = await createLocalDirectoryComputer(root);
  const second = await createLocalDirectoryComputer(root);

  assert.deepEqual(first.ref, second.ref);
  await first.destroy();
  await second.destroy();
});
