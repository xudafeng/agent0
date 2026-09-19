import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { app, BrowserWindow } from 'electron';

const profile = await mkdtemp(join(tmpdir(), 'agent0-smoke-'));
app.setPath('userData', profile);
process.env.AGENT0_PROFILE_DIR = profile;
let calls = 0;
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  assert.ok(JSON.parse(body).messages.length > 0);
  calls += 1;
  const message = calls === 1
    ? { content: null, tool_calls: [{ id: 'plan-1', type: 'function', function: { name: 'set_plan', arguments: JSON.stringify({ goal: 'Desktop verification', steps: ['Check desktop integration'] }) } }] }
    : { content: 'Desktop integration works. Your agent is ready.' };
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ id: `test-${calls}`, model: 'test-model', choices: [{ message, finish_reason: 'stop' }] }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
await writeFile(join(profile, '.env'), 'LLM_PROVIDER=kimi\nCUSTOM_SETTING=preserved\n');
delete process.env.MOONSHOT_API_KEY;
delete process.env.OPENAI_API_KEY;
const deadline = setTimeout(() => { console.error('Desktop smoke test timed out'); app.exit(1); }, 30000);
async function run() {
try {
  await import('../desktop/main.mjs');
  await app.whenReady();
  while (BrowserWindow.getAllWindows().length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
  const window = BrowserWindow.getAllWindows()[0];
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  if (window.webContents.isLoading()) await new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  async function waitFor(source) {
    for (let i = 0; i < 200; i += 1) {
      if (await evaluate(source)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Condition failed: ${source}`);
  }
  await waitFor('document.getElementById(\'settings\').open');
  async function switchLanguage(language, selector = '.sidebar [data-language]') {
    await evaluate(`
      (() => {
        const select = document.querySelector(${JSON.stringify(selector)});
        select.value = ${JSON.stringify(language)};
        select.dispatchEvent(new Event('change'));
      })();
    `);
  }
  await evaluate('document.getElementById(\'model\').value = \'unsaved-model\'');
  await switchLanguage('zh', '#settings [data-language]');
  assert.equal(await evaluate('document.documentElement.lang'), 'zh-CN');
  assert.equal(await evaluate('document.querySelector(\'#welcome h1\').textContent'), '今天想做些什么？');
  assert.equal(await evaluate('document.getElementById(\'model\').value'), 'unsaved-model');
  assert.equal(await evaluate('document.getElementById(\'save-settings\').textContent'), '保存设置');
  assert.equal(await evaluate('document.getElementById(\'send\').getAttribute(\'aria-label\')'), '发送消息');
  await evaluate('document.querySelector(\'[data-prompt]\').click()');
  assert.ok(await evaluate('document.getElementById(\'prompt\').value.includes(\'帮我安排今天\')'));
  await switchLanguage('en', '#settings [data-language]');
  assert.equal(await evaluate('document.getElementById(\'save-settings\').textContent'), 'Save settings');
  assert.ok(await evaluate('document.querySelector(\'[data-prompt]\').dataset.prompt.startsWith(\'Help me\')'));
  await switchLanguage('zh', '#settings [data-language]');
  await evaluate(`
    document.getElementById('model').value = 'test-model';
    document.getElementById('api-key').value = 'test-key';
    document.getElementById('base-url').value = 'http://127.0.0.1:${server.address().port}/v1';
    document.getElementById('settings-form').requestSubmit();
  `);
  await waitFor('!document.getElementById(\'settings\').open');
  assert.ok((await readFile(join(profile, '.env'), 'utf8')).includes('CUSTOM_SETTING=preserved'));
  assert.equal((await evaluate('window.agent0.state()')).config.apiKey, undefined);
  await writeFile(join(profile, 'welcome.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate(`document.getElementById('prompt').value = 'Create a plan'; document.getElementById('chat-form').requestSubmit();`);
  await waitFor('document.getElementById(\'conversation\').textContent.includes(\'Desktop integration works\')');
  assert.equal(calls, 2);
  assert.ok(await evaluate('document.getElementById(\'task\').textContent.includes(\'Desktop verification\')'));
  assert.ok(await evaluate('document.getElementById(\'activity\').textContent.includes(\'set_plan\')'));
  await evaluate('window.agent0.remember(\'Prefer concise answers\')');
  const before = await evaluate('window.agent0.state()');
  assert.ok(before.memory.includes('Prefer concise answers'));
  await evaluate('document.getElementById(\'prompt\').value = \'Keep this draft\'');
  assert.equal(await evaluate('document.querySelector(\'.message.user .message-name\').textContent'), '你');
  assert.ok(await evaluate('document.querySelector(\'.message-meta\').textContent.includes(\'个步骤\')'));
  await switchLanguage('en');
  assert.equal(await evaluate('document.querySelector(\'.message.user .message-name\').textContent'), 'You');
  assert.ok(await evaluate('document.getElementById(\'activity\').textContent.includes(\'returned\')'));
  assert.equal(await evaluate('document.getElementById(\'prompt\').value'), 'Keep this draft');
  assert.deepEqual((await evaluate('window.agent0.state()')).history, before.history);
  await switchLanguage('zh');
  assert.ok(await evaluate('document.getElementById(\'activity\').textContent.includes(\'已返回结果\')'));
  window.reload();
  await new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
  await waitFor('document.getElementById(\'conversation\').textContent.includes(\'Desktop integration works\')');
  assert.equal(await evaluate('document.documentElement.lang'), 'zh-CN');
  assert.ok(await evaluate('Array.from(document.querySelectorAll(\'[data-language]\')).every((select) => select.value === \'zh\')'));
  await writeFile(join(profile, 'conversation.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate('window.agent0.reset()');
  const after = await evaluate('window.agent0.state()');
  assert.equal(after.history.length, 0);
  assert.equal(after.task, null);
  assert.ok(after.memory.includes('Prefer concise answers'));
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(`PASS: setup, chat, MCP startup, tool events, task plan, memory, language switching, persistence, reload, reset. Screenshots: ${profile}`);
  clearTimeout(deadline);
  server.close();
  app.quit();
} catch (error) {
  console.error(error);
  clearTimeout(deadline);
  server.close();
  app.exit(1);
}

}
void run();
