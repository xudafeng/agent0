import dotenv from 'dotenv';
import { getProvider } from './provider.js';

dotenv.config({ path: '.env', override: true });

const cases = [
  {
    name: 'simple arithmetic',
    prompt: 'What is 2 + 3? Reply with only the number.',
    expected: '5',
  },
];

const provider = getProvider();
let passed = 0;

for (const testCase of cases) {
  const result = await provider.generate([{ role: 'user', content: testCase.prompt }]);
  const actual = result.text?.trim() ?? '';
  const ok = actual === testCase.expected;
  if (ok) passed += 1;

  console.log(`${ok ? 'PASS' : 'FAIL'} ${testCase.name}`);
  if (!ok) {
    console.log(`  expected: ${testCase.expected}`);
    console.log(`  actual:   ${actual}`);
  }
}

console.log(`\n${passed}/${cases.length} passed`);
process.exitCode = passed === cases.length ? 0 : 1;
