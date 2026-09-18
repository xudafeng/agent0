import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';
import dotenv from 'dotenv';
import { createAgentRuntime, describeTaskState } from './runtime.js';

dotenv.config({ path: '.env', override: true });

const rl = readline.createInterface({ input, output });
const runtime = await createAgentRuntime();

console.log('agent0 production runtime mode. Type exit to quit.');

try {
  while (true) {
    const prompt = (await rl.question('You: ')).trim();

    if (!prompt) continue;
    if (prompt === 'exit') break;

    if (prompt === '/memory') {
      console.log(runtime.getMemory());
      continue;
    }

    if (prompt === '/task') {
      console.log(describeTaskState(runtime.getTaskState()));
      continue;
    }

    if (prompt.startsWith('/remember ')) {
      await runtime.remember(prompt.slice('/remember '.length));
      console.log('Remembered.');
      continue;
    }

    try {
      const result = await runtime.run(prompt);
      console.log(`AI: ${result.text}`);
      console.error(`Run: ${result.runId} | steps: ${result.steps}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
} finally {
  rl.close();
  await runtime.close();
}
