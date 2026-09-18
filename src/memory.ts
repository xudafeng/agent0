import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const MEMORY_PATH = 'data/memory.md';
const MEMORY_HEADER = '# Memory\n\n';

async function ensureMemoryFile() {
  await mkdir(dirname(MEMORY_PATH), { recursive: true });

  try {
    await readFile(MEMORY_PATH, 'utf-8');
  } catch {
    await writeFile(MEMORY_PATH, MEMORY_HEADER, 'utf-8');
  }
}

export async function loadMemory(): Promise<string> {
  await ensureMemoryFile();
  return readFile(MEMORY_PATH, 'utf-8');
}

export async function remember(content: string): Promise<void> {
  const value = content.trim();
  if (!value) {
    throw new Error('Memory cannot be empty.');
  }

  await ensureMemoryFile();
  await appendFile(MEMORY_PATH, `- ${value}\n`, 'utf-8');
}
