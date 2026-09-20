import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { app, BrowserWindow } from 'electron';

// Record the real desktop UI against isolated, deterministic demonstration APIs.
const output = resolve(process.argv[2] || 'docs/images/agent0-jev-demo.gif');
const profile = await mkdtemp(join(tmpdir(), 'agent0-jev-demo-'));
const frames = join(profile, 'frames');
await mkdir(frames);
app.setPath('userData', profile);
process.env.AGENT0_PROFILE_DIR = profile;
process.env.AGENT0_SKILL_DIRS = '[]';
let decisions = 0;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = createServer(async (request, response) => {
  try {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    await delay(650);
    let result;
    if (request.url === '/jev') {
      decisions += 1;
      const criteria = input.questions.route.criteria;
      const choice = decisions === 1 ? Object.keys(criteria).find((key) => criteria[key].startsWith('add:')) : 'defer';
      assert.ok(choice);
      result = { model: 'jev-latest', answers: { route: { type: 'choice', choice, confidence: 0.96,
        probabilities: Object.fromEntries(Object.keys(criteria).map((key) => [key, key === choice ? 1 : 0])) } } };
    } else {
      const completed = input.messages.some((message) => message.role === 'tool');
      if (!completed) assert.deepEqual(input.tools.map((tool) => tool.function.name), ['add']);
      const message = completed
        ? { content: '128 + 256 = 384.\n\nCalculated with the add tool selected by Jev.' }
        : { content: null, tool_calls: [{ id: 'demo-add', type: 'function', function: { name: 'add', arguments: '{"a":128,"b":256}' } }] };
      result = { id: 'demo-response', model: 'demo-model', choices: [{ message, finish_reason: 'stop' }] };
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result));
  } catch (error) { console.error(error); response.writeHead(500); response.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
await writeFile(join(profile, '.env'), [
  'LLM_PROVIDER=kimi', 'MOONSHOT_API_KEY=demo-key', 'MOONSHOT_MODEL=demo-model',
  `MOONSHOT_BASE_URL=${endpoint}/v1`, 'JEV_ENABLED=false', `JEV_ENDPOINT=${endpoint}/jev`,
  'JEV_TIMEOUT_MS=3000', 'MCP_SERVERS_BASE64=W10=',
].join('\n'));
let recording = false;
let capture;
const deadline = setTimeout(() => { console.error('Recording timed out.'); app.exit(1); }, 90000);
async function run() {
try {
  await import('../desktop/main.mjs');
  await app.whenReady();
  while (!BrowserWindow.getAllWindows().length) await delay(50);
  const window = BrowserWindow.getAllWindows()[0];
  window.setSize(1320, 860);
  if (window.webContents.isLoading()) await new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  await evaluate(`localStorage.setItem('agent0.language', 'en')`);
  window.reload();
  await new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
  await delay(500);
  await evaluate(`(() => {
    const label = document.createElement('div');
    label.id = 'demo-label';
    label.style.cssText = 'position:fixed;top:65px;left:50%;transform:translateX(-50%);z-index:9999;background:#193f32;color:white;padding:10px 20px;border-radius:24px;font:13px system-ui;box-shadow:0 3px 16px #0002;pointer-events:none';
    document.body.append(label);
  })()`);
  const caption = (value) => evaluate(`(() => { const label = document.getElementById('demo-label'); label.textContent = ${JSON.stringify(value)}; (document.querySelector('dialog[open]') || document.body).append(label); })()`);
  const click = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const highlight = (id, enabled = true) => evaluate(`document.getElementById(${JSON.stringify(id)}).style.outline = ${JSON.stringify(enabled ? '3px solid #38a47a' : '')}`);
  let frame = 0;
  recording = true;
  capture = (async () => {
    while (recording) {
      const start = Date.now();
      const screenshot = (await window.webContents.capturePage()).resize({ width: 1100 });
      await writeFile(join(frames, `${String(frame++).padStart(5, '0')}.png`), screenshot.toPNG());
      await delay(Math.max(0, 100 - (Date.now() - start)));
    }
  })();
  await caption('Jev walkthrough · Demo with simulated APIs');
  await delay(1800);
  await highlight('jev-welcome-button');
  await delay(900);
  await click('jev-welcome-button');
  await highlight('jev-welcome-button', false);
  await caption('1 / Enable Jev routing · Simulated API demo');
  await delay(1500);
  await click('jev-enabled');
  await evaluate(`document.getElementById('jev-key').value = 'demo-typesafe-key'`);
  await highlight('jev-confidence');
  await delay(1800);
  await highlight('jev-confidence', false);
  await highlight('jev-save');
  await delay(700);
  await click('jev-save');
  await delay(700);
  await caption('2 / Ask a question · Simulated API demo');
  const prompt = 'What is 128 + 256? Please calculate it.';
  for (let i = 1; i <= prompt.length; i += 1) {
    await evaluate(`document.getElementById('prompt').value = ${JSON.stringify(prompt.slice(0, i))}; document.getElementById('prompt').dispatchEvent(new Event('input'))`);
    await delay(40);
  }
  await delay(700);
  await click('send');
  await caption('3 / Jev selects the tool · Simulated API demo');
  for (let i = 0; i < 100; i += 1) {
    if (await evaluate(`document.getElementById('conversation').textContent.includes('128 + 256 = 384.')`)) break;
    await delay(100);
  }
  assert.equal(decisions, 2);
  assert.ok(await evaluate(`document.getElementById('activity').textContent.includes('Jev selected add')`));
  assert.ok(await evaluate(`document.getElementById('conversation').textContent.includes('128 + 256 = 384.')`));
  await highlight('activity');
  await caption('96% confidence → add → 384 · Simulated API demo');
  await delay(3500);
  await highlight('activity', false);
  await caption('Jev routes. Your model reasons and replies. · Demo');
  await delay(2500);
  recording = false;
  await capture;
  const ffmpeg = (args) => {
    const result = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
  };
  const pattern = join(frames, '%05d.png');
  const palette = join(profile, 'palette.png');
  ffmpeg(['-framerate', '10', '-i', pattern, '-vf', 'palettegen=stats_mode=diff', '-frames:v', '1', palette]);
  ffmpeg(['-framerate', '10', '-i', pattern, '-i', palette, '-lavfi', 'paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle', '-loop', '0', output]);
  console.log(`Saved ${frame} frames: ${output}\nFrames: ${frames}`);
  clearTimeout(deadline);
  server.close();
  app.quit();
} catch (error) {
  recording = false;
  await capture;
  console.error(error);
  clearTimeout(deadline);
  server.close();
  app.exit(1);
}
}
void run();
