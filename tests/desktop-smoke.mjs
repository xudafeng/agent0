import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { loadMcpServers } from '../dist/mcp-config.js';
import { createServer } from 'node:http';
import { app, BrowserWindow, dialog } from 'electron';
import { startRemoteMcp } from './fixtures/remote-mcp.mjs';

const profile = await mkdtemp(join(tmpdir(), 'agent0-smoke-'));
await mkdir(join(profile, 'workspace'));
const workspace = await realpath(join(profile, 'workspace'));
await writeFile(join(workspace, 'note.txt'), 'Bundled filesystem works.');
const skillDirectory = join(profile, 'skills');
await mkdir(join(skillDirectory, 'desktop-check', 'references'), { recursive: true });
await writeFile(join(skillDirectory, 'desktop-check', 'SKILL.md'), '---\nname: desktop-check\ndescription: Verify the desktop skill workflow.\n---\nUse the desktop verification checklist.\n');
await writeFile(join(skillDirectory, 'desktop-check', 'references', 'checklist.md'), 'Skill reference works.');
process.env.AGENT0_SKILL_DIRS = JSON.stringify([skillDirectory]);
app.setPath('userData', profile);
process.env.AGENT0_PROFILE_DIR = profile;
const remoteFixture = await startRemoteMcp();
let calls = 0;
let jevCalls = 0;
let routingRun = false;
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  if (request.url === '/jev') {
    jevCalls += 1;
    assert.equal(request.headers.authorization, 'Bearer jev-secret');
    const criteria = input.questions.route.criteria;
    const selected = jevCalls === 1 ? Object.keys(criteria).find((key) => criteria[key].startsWith('add:')) : 'defer';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ model: 'jev-test', answers: { route: { type: 'choice', choice: selected, confidence: 0.95,
      probabilities: Object.fromEntries(Object.keys(criteria).map((key) => [key, key === selected ? 1 : 0])) } } }));
    return;
  }
  assert.ok(input.messages.length > 0);
  if (routingRun) {
    if (jevCalls === 1) assert.deepEqual(input.tools.map((tool) => tool.function.name), ['add']);
    else {
      assert.ok(input.tools.length > 1);
      assert.ok(input.messages.some((message) => message.role === 'tool' && message.content.includes('"result":5')));
    }
    const message = jevCalls === 1
      ? { content: null, tool_calls: [{ id: 'jev-add', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":3}' } }] }
      : { content: 'Jev routing works: 5.' };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'jev-test', model: 'test-model', choices: [{ message, finish_reason: 'stop' }] }));
    return;
  }
  const mcpTool = input.tools.find((tool) => tool.function.name.startsWith('mcp_smoke__greet_'));
  const filesystemTool = input.tools.find((tool) => tool.function.name.startsWith('mcp_builtin-filesystem__read_text_file_'));
  const remoteTool = input.tools.find((tool) => tool.function.name.startsWith('mcp_remote__echo_'));
  assert.ok(mcpTool);
  assert.ok(filesystemTool);
  assert.ok(remoteTool);
  calls += 1;
  const message = calls === 1
    ? { content: null, tool_calls: [{ id: 'plan-1', type: 'function', function: { name: 'set_plan', arguments: JSON.stringify({ goal: 'Desktop verification', steps: ['Check desktop integration'] }) } }] }
    : calls === 2
      ? { content: null, tool_calls: [{ id: 'mcp-1', type: 'function', function: { name: mcpTool.function.name, arguments: JSON.stringify({ name: 'MCP desktop' }) } }] }
      : calls === 3
        ? { content: null, tool_calls: [{ id: 'filesystem-1', type: 'function', function: { name: filesystemTool.function.name, arguments: JSON.stringify({ path: join(workspace, 'note.txt') }) } }] }
        : calls === 4
          ? { content: null, tool_calls: [{ id: 'remote-1', type: 'function', function: { name: remoteTool.function.name, arguments: JSON.stringify({ message: 'desktop remote works' }) } }] }
          : calls === 5
            ? { content: null, tool_calls: [{ id: 'skill-1', type: 'function', function: { name: 'load_skill', arguments: JSON.stringify({ name: 'desktop-check' }) } }] }
            : calls === 6
              ? { content: null, tool_calls: [{ id: 'skill-file-1', type: 'function', function: { name: 'read_skill_file', arguments: JSON.stringify({ name: 'desktop-check', path: 'references/checklist.md' }) } }] }
              : { content: 'Desktop integration works. Your agent is ready.' };
  if (calls === 3) assert.ok(input.messages.some((message) => message.role === 'tool' && message.content.includes('Hello, MCP desktop!')));
  if (calls === 4) assert.ok(input.messages.some((message) => message.role === 'tool' && message.content.includes('Bundled filesystem works.')));
  if (calls === 5) assert.ok(input.messages.some((message) => message.role === 'tool' && message.content.includes('Remote: desktop remote works')));
  assert.ok(input.tools.some((tool) => tool.function.name === 'load_skill'));
  const system = input.messages.find((message) => message.role === 'system').content;
  assert.ok(system.includes('desktop-check'));
  assert.equal(system.includes('Use the desktop verification checklist.'), calls >= 6);
  if (calls === 7) assert.ok(input.messages.some((message) => message.role === 'tool' && message.content.includes('Skill reference works.')));
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ id: `test-${calls}`, model: 'test-model', choices: [{ message, finish_reason: 'stop' }] }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
await writeFile(join(profile, '.env'), 'LLM_PROVIDER=kimi\nCUSTOM_SETTING=preserved\n');
delete process.env.MOONSHOT_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.TYPESAFE_API_KEY;
process.env.JEV_ENABLED = 'false';
process.env.JEV_ENDPOINT = `http://127.0.0.1:${server.address().port}/jev`;
process.env.JEV_TIMEOUT_MS = '3000';
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
  const initialSkills = await evaluate('window.agent0.skillsList()');
  assert.equal(initialSkills.skills[0].name, 'desktop-check');
  assert.deepEqual(initialSkills.loaded, []);
  assert.equal(calls, 0);

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
  await evaluate(`document.getElementById('skills-button').click()`);
  await waitFor(`document.querySelector('.skill-card button') && !document.getElementById('skills-refresh').disabled`);
  assert.ok(await evaluate(`document.getElementById('skills-list').textContent.includes('desktop-check')`));
  await evaluate(`document.getElementById('prompt').value = 'Review my task'; document.querySelector('.skill-card button').click()`);
  assert.equal(await evaluate(`document.getElementById('prompt').value`), '$desktop-check Review my task');
  assert.equal(await evaluate(`document.getElementById('skills-dialog').open`), false);

  await evaluate('document.getElementById(\'mcp-button\').click()');
  await waitFor('document.getElementById(\'mcp-settings\').open && !document.getElementById(\'mcp-save\').disabled');
  const mcpServer = {
    id: 'smoke', command: process.execPath,
    args: [fileURLToPath(new URL('../dist/mcp-server.js', import.meta.url))],
    env: { ELECTRON_RUN_AS_NODE: '1', TEST_SECRET: 'local-only' },
  };
  await evaluate(`
    document.getElementById('mcp-id').value = ${JSON.stringify(mcpServer.id)};
    document.getElementById('mcp-command').value = ${JSON.stringify(mcpServer.command)};
    document.getElementById('mcp-args').value = 'invalid JSON';
    document.getElementById('mcp-test').click();
  `);
  assert.ok(await evaluate('!document.getElementById(\'mcp-error\').hidden'));
  await evaluate(`
    document.getElementById('mcp-args').value = ${JSON.stringify(JSON.stringify(mcpServer.args))};
    document.getElementById('mcp-env').value = ${JSON.stringify(JSON.stringify(mcpServer.env))};
    document.getElementById('mcp-test').click();
  `);
  await waitFor('!document.getElementById(\'mcp-test\').disabled && document.getElementById(\'mcp-tools\').textContent.includes(\'greet\')');
  assert.equal((await evaluate('window.agent0.mcpList()')).length, 0);
  await writeFile(join(profile, 'mcp-settings.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate('document.getElementById(\'mcp-form\').requestSubmit()');
  await waitFor('document.querySelector(\'.mcp-server\') && !document.getElementById(\'mcp-save\').disabled');
  assert.equal(await evaluate('document.querySelector(\'.mcp-server\').dataset.connection'), 'reachable');
  await switchLanguage('en');
  assert.equal(await evaluate('document.querySelector(\'.mcp-connection\').textContent'), 'Reachable');
  await switchLanguage('zh');
  assert.equal(await evaluate('document.querySelector(\'.mcp-connection\').textContent'), '可连接');
  await evaluate('document.querySelector(\'.mcp-server-actions button\').click()');
  await waitFor('!document.getElementById(\'mcp-enabled\').checked && !document.getElementById(\'mcp-save\').disabled');
  assert.equal((await evaluate('window.agent0.mcpList()'))[0].enabled, false);
  assert.equal(await evaluate('document.querySelector(\'.mcp-server\').dataset.connection'), 'disabled');
  await evaluate('document.querySelector(\'.mcp-server-actions button\').click()');
  await waitFor('document.getElementById(\'mcp-enabled\').checked && !document.getElementById(\'mcp-save\').disabled');
  const savedEnv = dotenv.parse(await readFile(join(profile, '.env')));
  assert.equal(savedEnv.CUSTOM_SETTING, 'preserved');
  assert.equal(savedEnv.MOONSHOT_API_KEY, 'test-key');
  assert.equal(loadMcpServers(savedEnv.MCP_SERVERS_BASE64)[0].env.TEST_SECRET, 'local-only');
  assert.ok(!JSON.stringify(await evaluate('window.agent0.state()')).includes('local-only'));
  await evaluate(`
    document.getElementById('mcp-add').click();
    document.getElementById('mcp-id').value = 'broken';
    document.getElementById('mcp-command').value = '/missing/executable';
    document.getElementById('mcp-form').requestSubmit();
  `);
  await waitFor('document.querySelector(\'[data-server-id="broken"]\')?.dataset.connection === \'failed\' && !document.getElementById(\'mcp-save\').disabled');
  assert.ok(await evaluate('document.querySelector(\'[data-server-id="broken"] .mcp-connection-error\').textContent.includes(\'ENOENT\')'));
  await writeFile(join(profile, 'mcp-connectivity.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate('document.getElementById(\'mcp-refresh\').click()');
  assert.equal(await evaluate('document.querySelector(\'[data-server-id="smoke"]\').dataset.connection'), 'checking');
  await waitFor('!document.getElementById(\'mcp-refresh\').disabled');
  assert.equal(await evaluate('document.querySelector(\'[data-server-id="smoke"]\').dataset.connection'), 'reachable');
  assert.equal(await evaluate('document.querySelector(\'[data-server-id="broken"]\').dataset.connection'), 'failed');
  await evaluate(`
    document.getElementById('mcp-command').value = ${JSON.stringify(mcpServer.command)};
    document.getElementById('mcp-args').value = ${JSON.stringify(JSON.stringify(mcpServer.args))};
    document.getElementById('mcp-env').value = ${JSON.stringify(JSON.stringify(mcpServer.env))};
    document.getElementById('mcp-form').requestSubmit();
  `);
  await waitFor('document.querySelector(\'[data-server-id="broken"]\')?.dataset.connection === \'reachable\' && !document.getElementById(\'mcp-save\').disabled');
  assert.equal(await evaluate('document.querySelector(\'[data-server-id="broken"] .mcp-connection-error\')'), null);
  await evaluate('document.querySelector(\'[data-server-id="broken"] .mcp-server-actions button:last-child\').click()');
  await waitFor('!document.querySelector(\'[data-server-id="broken"]\') && !document.getElementById(\'mcp-save\').disabled');
  await evaluate('document.getElementById(\'mcp-filesystem\').click(); document.getElementById(\'mcp-test\').click()');
  assert.ok(await evaluate('document.getElementById(\'mcp-error\').textContent.includes(\'请先选择文件夹\')'));
  const originalDialog = dialog.showOpenDialog;
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  await evaluate('document.getElementById(\'mcp-pick-directory\').click()');
  await waitFor('!document.getElementById(\'mcp-pick-directory\').disabled');
  assert.equal(await evaluate('document.getElementById(\'mcp-directory\').value'), '');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  await evaluate('document.getElementById(\'mcp-pick-directory\').click()');
  await waitFor('document.getElementById(\'mcp-directory\').value && !document.getElementById(\'mcp-pick-directory\').disabled');
  dialog.showOpenDialog = originalDialog;
  assert.equal(await evaluate('document.getElementById(\'mcp-directory\').value'), await realpath(workspace));
  await evaluate('document.getElementById(\'mcp-test\').click()');
  await waitFor('document.getElementById(\'mcp-tools\').textContent.includes(\'read_text_file\') && !document.getElementById(\'mcp-test\').disabled');
  assert.equal((await evaluate('window.agent0.mcpList()')).length, 1);
  await evaluate('document.getElementById(\'mcp-form\').requestSubmit()');
  await waitFor('document.querySelector(\'[data-server-id="builtin-filesystem"]\')?.dataset.connection === \'reachable\' && !document.getElementById(\'mcp-save\').disabled');
  await writeFile(join(profile, 'filesystem.png'), (await window.webContents.capturePage()).toPNG());
  const filesystemConfig = (await evaluate('window.agent0.mcpList()')).find((item) => item.builtin);
  assert.equal(filesystemConfig.directory, await realpath(workspace));
  assert.equal(filesystemConfig.command, undefined);
  await evaluate(`
    document.getElementById('mcp-add').click();
    document.getElementById('mcp-transport').value = 'http';
    document.getElementById('mcp-transport').dispatchEvent(new Event('change'));
    document.getElementById('mcp-id').value = 'remote';
    document.getElementById('mcp-url').value = ${JSON.stringify(`${remoteFixture.url}/mcp`)};
    document.getElementById('mcp-test').click();
  `);
  await waitFor('!document.getElementById(\'mcp-test\').disabled && !document.getElementById(\'mcp-error\').hidden');
  assert.equal(await evaluate('document.getElementById(\'mcp-command\').required'), false);
  await evaluate(`
    document.getElementById('mcp-headers').value = ${JSON.stringify(JSON.stringify({ Authorization: 'Bearer test-remote-token' }))};
    document.getElementById('mcp-test').click();
  `);
  await waitFor('!document.getElementById(\'mcp-test\').disabled && document.getElementById(\'mcp-tools\').textContent.includes(\'echo\')');
  await evaluate('document.getElementById(\'mcp-form\').requestSubmit()');
  await waitFor('document.querySelector(\'[data-server-id="remote"]\')?.dataset.connection === \'reachable\' && !document.getElementById(\'mcp-save\').disabled');
  const remoteConfig = (await evaluate('window.agent0.mcpList()')).find((item) => item.id === 'remote');
  assert.equal(remoteConfig.url, `${remoteFixture.url}/mcp`);
  assert.equal(remoteConfig.transport, 'http');
  assert.equal(remoteConfig.headers.Authorization, 'Bearer test-remote-token');
  assert.ok(!JSON.stringify(await evaluate('window.agent0.state()')).includes('test-remote-token'));
  await writeFile(join(profile, 'remote-mcp.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate('document.getElementById(\'close-mcp\').click()');
  await writeFile(join(profile, 'welcome.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate(`document.getElementById('prompt').value = 'Create a plan'; document.getElementById('chat-form').requestSubmit();`);
  for (const expected of ['mcp_smoke__greet_', 'mcp_builtin-filesystem__read_text_file_', 'mcp_remote__echo_']) {
    await waitFor(`document.getElementById('tool-approval').open && document.getElementById('tool-approval-name').textContent.includes(${JSON.stringify(expected)})`);
    assert.ok(await evaluate('document.getElementById(\'tool-approval-arguments\').textContent.length > 2'));
    await evaluate('document.getElementById(\'tool-approve\').click()');
    await waitFor('!document.getElementById(\'tool-approval\').open');
  }
  await waitFor('document.getElementById(\'conversation\').textContent.includes(\'Desktop integration works\')');
  assert.equal(calls, 7);
  assert.deepEqual((await evaluate('window.agent0.skillsList()')).loaded, ['desktop-check']);
  await evaluate(`document.getElementById('skills-button').click()`);
  await waitFor(`document.getElementById('skills-dialog').open && document.getElementById('skills-list').textContent.includes('已加载') && !document.getElementById('skills-refresh').disabled`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await writeFile(join(profile, 'skills.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate(`document.getElementById('close-skills').click()`);

  assert.ok(await evaluate('document.getElementById(\'task\').textContent.includes(\'Desktop verification\')'));
  assert.ok(await evaluate('document.getElementById(\'activity\').textContent.includes(\'set_plan\')'));
  await evaluate('window.agent0.remember(\'Prefer concise answers\')');
  const before = await evaluate('window.agent0.state()');
  assert.ok(before.memory.includes('Prefer concise answers'));
  await evaluate('window.agent0.mcpCheck()');
  assert.deepEqual((await evaluate('window.agent0.state()')).history, before.history);
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
  assert.deepEqual((await evaluate('window.agent0.skillsList()')).loaded, []);
  assert.ok(after.memory.includes('Prefer concise answers'));
  await evaluate('document.getElementById(\'mcp-button\').click()');
  await waitFor('document.getElementById(\'mcp-id\').value === \'smoke\' && !document.getElementById(\'mcp-save\').disabled');
  await evaluate('document.querySelector(\'[data-server-id="remote"] .mcp-server-name\').click()');
  assert.equal(await evaluate('document.getElementById(\'mcp-transport\').value'), 'http');
  assert.equal(await evaluate('document.getElementById(\'mcp-url\').value'), `${remoteFixture.url}/mcp`);
  await evaluate('document.querySelector(\'[data-server-id="remote"] .mcp-server-actions button:last-child\').click()');
  await waitFor('!document.querySelector(\'[data-server-id="remote"]\') && !document.getElementById(\'mcp-save\').disabled');
  await evaluate('document.getElementById(\'mcp-filesystem\').click()');
  assert.equal(await evaluate('document.getElementById(\'mcp-directory\').value'), await realpath(workspace));
  await evaluate('document.querySelector(\'[data-server-id="builtin-filesystem"] .mcp-server-actions button\').click()');
  await waitFor('document.querySelector(\'[data-server-id="builtin-filesystem"]\')?.dataset.connection === \'disabled\' && !document.getElementById(\'mcp-save\').disabled');
  await evaluate('document.querySelector(\'[data-server-id="builtin-filesystem"] .mcp-server-actions button:last-child\').click()');
  await waitFor('!document.querySelector(\'[data-server-id="builtin-filesystem"]\') && !document.getElementById(\'mcp-save\').disabled');
  await evaluate('document.querySelector(\'.mcp-server-actions button:last-child\').click()');
  await waitFor('!document.querySelector(\'.mcp-server\') && !document.getElementById(\'mcp-save\').disabled');
  assert.equal((await evaluate('window.agent0.mcpList()')).length, 0);
  await evaluate('document.getElementById(\'close-mcp\').click()');
  await evaluate('document.getElementById(\'jev-button\').click()');
  await evaluate('document.getElementById(\'jev-enabled\').checked = true; document.getElementById(\'jev-form\').requestSubmit()');
  await waitFor('!document.getElementById(\'jev-error\').hidden');
  assert.equal((await evaluate('window.agent0.state()')).config.jev.enabled, false);
  await evaluate('document.getElementById(\'jev-key\').value = \'jev-secret\'; document.getElementById(\'jev-form\').requestSubmit()');
  await waitFor('!document.getElementById(\'jev-settings\').open');
  assert.equal((await evaluate('window.agent0.state()')).config.jev.enabled, true);
  assert.ok(!JSON.stringify(await evaluate('window.agent0.state()')).includes('jev-secret'));
  assert.equal(dotenv.parse(await readFile(join(profile, '.env'))).TYPESAFE_API_KEY, 'jev-secret');
  assert.equal(dotenv.parse(await readFile(join(profile, '.env'))).MOONSHOT_API_KEY, 'test-key');
  await evaluate('document.getElementById(\'jev-button\').click()');
  assert.equal(await evaluate('document.getElementById(\'jev-key\').value'), '');
  await new Promise((resolve) => setTimeout(resolve, 150));
  await writeFile(join(profile, 'jev-settings.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate('document.getElementById(\'jev-form\').requestSubmit()');
  await waitFor('!document.getElementById(\'jev-settings\').open');
  assert.equal(dotenv.parse(await readFile(join(profile, '.env'))).TYPESAFE_API_KEY, 'jev-secret');
  routingRun = true;
  await evaluate('document.getElementById(\'prompt\').value = \'Add 2 and 3\'; document.getElementById(\'chat-form\').requestSubmit()');
  await waitFor('document.getElementById(\'conversation\').textContent.includes(\'Jev routing works: 5.\')');
  assert.equal(jevCalls, 2);
  assert.equal((await evaluate('window.agent0.state()')).events.filter((event) => event.type === 'jev_decision').length, 2);
  await switchLanguage('en');
  assert.ok(await evaluate('document.getElementById(\'activity\').textContent.includes(\'Jev selected add\')'));
  assert.ok(await evaluate('document.getElementById(\'activity\').textContent.includes(\'Jev deferred to main model\')'));
  await new Promise((resolve) => setTimeout(resolve, 150));
  await writeFile(join(profile, 'jev-activity.png'), (await window.webContents.capturePage()).toPNG());
  assert.ok(!(await readFile(join(profile, 'data/traces.ndjson'), 'utf8')).includes('jev-secret'));
  await evaluate('document.getElementById(\'jev-button\').click(); document.getElementById(\'jev-enabled\').checked = false; document.getElementById(\'jev-form\').requestSubmit()');
  await waitFor('!document.getElementById(\'jev-settings\').open');
  assert.equal((await evaluate('window.agent0.state()')).config.jev.enabled, false);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(`PASS: setup, chat, MCP settings, external tool calls, task plan, memory, language switching, persistence, reload, reset, skills discovery and loading, Jev settings and routing. Screenshots: ${profile}`);
  clearTimeout(deadline);
  server.close();
  await remoteFixture.close();
  app.quit();
} catch (error) {
  console.error(error);
  clearTimeout(deadline);
  server.close();
  await remoteFixture.close();
  app.exit(1);
}

}
void run();
