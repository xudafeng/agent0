import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, writeFile, rename, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { createAgentRuntime } from '../dist/runtime.js';
import { loadMemory } from '../dist/memory.js';
import { createSkillRuntime, skillDirectories } from '../dist/skills.js';
import { jevConfiguration } from '../dist/jev.js';
import { checkMcpServers, connectMcpServer } from '../dist/mcp.js';
import { encodeMcpServers, loadMcpServers, mcpConfigKey, validateMcpServers } from '../dist/mcp-config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const icon = path.join(root, 'desktop/assets/icon.png');
let window;
let runtime;
let busy = false;
let history = [];
let events = [];
let configPath;
let savedMemory = '';
const smokeTest = process.argv.includes('--agent0-smoke-test');

function configuration() {
  const provider = process.env.LLM_PROVIDER || 'kimi';
  const kimi = provider !== 'openai';
  return {
    provider,
    model: process.env[kimi ? 'MOONSHOT_MODEL' : 'OPENAI_MODEL'] || '',
    baseURL: kimi ? process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.cn/v1' : '',
    configured: Boolean(process.env[kimi ? 'MOONSHOT_API_KEY' : 'OPENAI_API_KEY']),
    jev: jevConfiguration(),
  };
}

function state() {
  return { history, events, busy, config: configuration(), memory: runtime?.getMemory() || savedMemory, task: runtime?.getTaskState() || null };
}

function publish(type, data) {
  if (window && !window.isDestroyed()) window.webContents.send('agent:event', { type, data });
}

async function getRuntime() {
  runtime ||= await createAgentRuntime();
  return runtime;
}

function text(value, name, limit = 32000) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`Invalid ${name}.`);
  return value.trim();
}

function handle(name, action) {
  ipcMain.handle(`agent:${name}`, async (event, payload) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Unknown sender.');
    if (name === 'state' || name === 'mcp-list') return action(payload);
    if (busy) throw new Error('Wait for the current operation to finish.');
    busy = true;
    publish('state', state());
    try {
      return await action(payload);
    } finally {
      busy = false;
      publish('state', state());
    }
  });
}

handle('state', state);
handle('skills-list', async () => {
  const directories = skillDirectories();
  if (runtime) return { ...runtime.getSkills(), directories };
  const skills = await createSkillRuntime(directories);
  return { skills: skills.list(), diagnostics: skills.diagnostics, loaded: [], directories };
});
handle('jev-save', async (input) => {
  if (!input || typeof input.enabled !== 'boolean' || typeof input.apiKey !== 'string' ||
      !Number.isFinite(input.minConfidence) || input.minConfidence < 0 || input.minConfidence > 1) throw new Error('Invalid Jev settings.');
  const model = text(input.model, 'Jev model', 200);
  const apiKey = input.apiKey.trim() || process.env.TYPESAFE_API_KEY || '';
  if (input.enabled && !apiKey) throw new Error('Enter a TypeSafe API key.');
  const values = { JEV_ENABLED: String(input.enabled), JEV_MODEL: model, JEV_MIN_CONFIDENCE: String(input.minConfidence), TYPESAFE_API_KEY: apiKey };
  if (apiKey.length > 2000 || Object.values(values).some((value) => /[\r\n"\\]/.test(value))) throw new Error('Configuration contains unsupported characters.');
  let existing = '';
  try { existing = await readFile(configPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const preserved = existing.split('\n').filter((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z_0-9]*)\s*=/);
    return !match || !Object.hasOwn(values, match[1]);
  }).join('\n').trimEnd();
  const temporary = `${configPath}.jev-tmp`;
  await writeFile(temporary, `${preserved}\n${Object.entries(values).map(([key, value]) => `${key}="${value}"`).join('\n')}\n`, { mode: 0o600 });
  await rename(temporary, configPath);
  Object.assign(process.env, values);
  await runtime?.close();
  runtime = undefined;
  history = [];
  events = [];
});
handle('mcp-list', () => loadMcpServers());
handle('mcp-pick-directory', async () => {
  const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  return realpath(result.filePaths[0]);
});
handle('mcp-check', async (id) => {
  const servers = loadMcpServers();
  if (id !== undefined && (typeof id !== 'string' || !servers.some((server) => server.id === id))) throw new Error('Unknown MCP server.');
  return checkMcpServers(id === undefined ? servers : servers.filter((server) => server.id === id));
});
handle('mcp-test', async (input) => {
  const [server] = validateMcpServers([input]);
  const connection = await connectMcpServer(server, false);
  try { return connection.tools; }
  finally { await connection.close(); }
});
handle('mcp-save', async (input) => {
  const encoded = encodeMcpServers(input);
  let existing = '';
  try { existing = await readFile(configPath, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const preserved = existing.split('\n').filter((line) => !/^\s*(?:export\s+)?MCP_SERVERS_BASE64\s*=/.test(line)).join('\n').trimEnd();
  const temporary = `${configPath}.mcp-tmp`;
  await writeFile(temporary, `${preserved}\n${mcpConfigKey}=${encoded}\n`, { mode: 0o600 });
  await rename(temporary, configPath);
  process.env[mcpConfigKey] = encoded;
  await runtime?.close();
  runtime = undefined;
  history = [];
  events = [];
});
handle('send', async (prompt) => {
  const value = text(prompt, 'message');
  const agent = await getRuntime();
  history.push({ role: 'user', content: value });
  events = [];
  publish('state', state());
  try {
    const result = await agent.run(value, (event) => {
      events.push(event);
      publish('trace', event);
      publish('state', state());
    });
    history.push({ role: 'assistant', content: result.text, steps: result.steps });
  } catch (error) {
    history.push({ role: 'error', content: error instanceof Error ? error.message : String(error) });
    throw error;
  }
});
handle('reset', async () => {
  await runtime?.close();
  runtime = undefined;
  history = [];
  events = [];
});
handle('remember', async (content) => {
  await (await getRuntime()).remember(text(content, 'memory', 4000));
  savedMemory = runtime.getMemory();
});
handle('configure', async (input) => {
  if (!input || !['openai', 'kimi'].includes(input.provider)) throw new Error('Choose a provider.');
  const model = text(input.model, 'model', 200);
  const prefix = input.provider === 'kimi' ? 'MOONSHOT' : 'OPENAI';
  const apiKey = input.apiKey ? text(input.apiKey, 'API key', 2000) : process.env[`${prefix}_API_KEY`];
  if (!apiKey) throw new Error('Enter an API key.');
  const values = { LLM_PROVIDER: input.provider, [`${prefix}_MODEL`]: model, [`${prefix}_API_KEY`]: apiKey };
  if (input.provider === 'kimi') {
    const url = new URL(text(input.baseURL, 'base URL', 2000));
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Use an HTTP or HTTPS base URL.');
    values.MOONSHOT_BASE_URL = url.toString().replace(/\/$/, '');
  }
  if (Object.values(values).some((value) => /[\r\n"\\]/.test(value))) throw new Error('Configuration contains unsupported characters.');
  let existing = '';
  try { existing = await readFile(configPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const preserved = existing.split('\n').filter((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z_0-9]*)\s*=/);
    return !match || !(match[1] in values);
  }).join('\n').trimEnd();
  await writeFile(configPath, `${preserved}\n${Object.entries(values).map(([key, value]) => `${key}="${value}"`).join('\n')}\n`, { mode: 0o600 });
  Object.assign(process.env, values);
  await runtime?.close();
  runtime = undefined;
  history = [];
  events = [];
});

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock.setIcon(icon);
  const smokeDirectory = smokeTest ? await mkdtemp(path.join(tmpdir(), 'agent0-packaged-')) : undefined;
  if (smokeDirectory) app.setPath('userData', smokeDirectory);
  const dataDirectory = smokeDirectory || (app.isPackaged ? app.getPath('userData') : process.env.AGENT0_PROFILE_DIR || root);
  if (smokeTest) {
    process.env.AGENT0_SKILL_DIRS = '[]';
    process.env.MOONSHOT_API_KEY = '';
    process.env.OPENAI_API_KEY = '';
  }
  await mkdir(dataDirectory, { recursive: true });
  process.chdir(dataDirectory);
  configPath = path.join(dataDirectory, '.env');
  dotenv.config({ path: configPath, override: true, quiet: true });
  savedMemory = await loadMemory();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));

  function createWindow() {
    window = new BrowserWindow({
      width: 1320, height: 860, minWidth: 860, minHeight: 620,
      title: 'agent0', backgroundColor: '#f6f7f9', titleBarStyle: 'hiddenInset',
      icon,
      webPreferences: { preload: path.join(root, 'desktop/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    const loaded = window.loadFile(path.join(root, 'web/index.html'));
    if (smokeTest) void loaded.then(async () => {
      const ready = await window.webContents.executeJavaScript(`(async () => {
        const state = await window.agent0.state();
        const catalog = await window.agent0.skillsList();
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (document.getElementById('settings').open && document.getElementById('skills-button').onclick) {
            return state.history.length === 0 && catalog.skills.length === 0 && document.getElementById('error').hidden;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return false;
      })()`);
      if (!ready) throw new Error('Packaged renderer failed its startup check.');
      console.log('PASS: packaged application, preload, renderer, and skill discovery.');
      app.exit(0);
    }).catch((error) => { console.error(error); app.exit(1); });
  }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void Promise.race([runtime?.close(), new Promise((resolve) => setTimeout(resolve, 2000))]).finally(() => app.quit());
  });

}).catch((error) => {
  console.error(error);
  app.exit(1);
});
