import { applyLanguage, setLanguage, t } from './i18n.js';
import { setupMcpSettings } from './mcp-settings.js';
import { setupJevSettings, jevActivityLabel } from './jev-settings.js';

const $ = (id) => document.getElementById(id);
const api = window.agent0;
let current;
let sending = false;
let renderedHistory = '';
let progressEvent;
let keepSavedKey = false;

applyLanguage();
const mcpSettings = setupMcpSettings();
const jevSettings = setupJevSettings();

function element(tag, className, value) {
  const node = document.createElement(tag);
  node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

function showError(error, target = 'error') {
  const message = error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  $(target).dataset.error = message;
  $(target).textContent = t(message);
  $(target).hidden = false;
}

function render(state) {
  current = state;
  const { config, history, busy, task, memory, events } = state;
  const locked = busy || sending;
  mcpSettings.setBusy(locked);
  jevSettings.render(config.jev, locked);
  $('connection-label').textContent = busy ? t('Working') : config.configured ? t('Ready') : t('Setup needed');
  $('model-label').textContent = config.model || t('Connect a model to get started');
  $('send').disabled = locked || !$('prompt').value.trim();
  $('new-chat').disabled = locked;
  $('settings-button').disabled = locked;
  $('memory-input').disabled = locked;
  $('memory-form').querySelector('button').disabled = locked;
  $('progress').hidden = !busy;
  $('welcome').hidden = history.length > 0;
  const serialized = JSON.stringify(history);
  if (serialized !== renderedHistory) {
    renderedHistory = serialized;
    $('conversation').replaceChildren(...history.map((message) => {
      const row = element('article', `message ${message.role}`);
      row.append(element('div', 'avatar', message.role === 'user' ? t('You') : 'a0'));
      const body = element('div', 'message-body');
      body.append(element('div', 'message-name', message.role === 'user' ? t('You') : message.role === 'error' ? t('Something went wrong') : 'agent0'));
      body.append(element('div', 'message-content', message.role === 'error' ? t(message.content) : message.content));
      if (message.steps) body.append(element('div', 'message-meta', t(message.steps === 1 ? 'Completed in {count} step' : 'Completed in {count} steps', { count: message.steps })));
      row.append(body);
      return row;
    }));
    $('messages').scrollTop = $('messages').scrollHeight;
  }
  $('task').className = task ? '' : 'empty-panel';
  $('task').replaceChildren();
  if (task) {
    $('task').append(element('div', 'task-goal', task.goal));
    for (const step of task.steps) {
      const row = element('div', `task-step ${step.status}`);
      row.append(element('span', '', step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '◉' : '○'), element('span', '', step.description));
      $('task').append(row);
    }
  } else $('task').textContent = t('A little structure goes a long way. Your task plan will appear here.');
  const memoryContent = memory.replace(/^# Memory\s*/, '').trim();
  $('memory').textContent = memoryContent || t('Save useful context for future conversations.');
  $('memory').classList.toggle('empty-panel', !memoryContent);
  const activity = events.filter((event) => ['jev_decision', 'tool_call', 'tool_result', 'run_error', 'final_answer'].includes(event.type));
  $('activity-count').textContent = activity.length;
  // Avoid rebuilding activity details when only unrelated state changes.
  if ($('activity').dataset.snapshot !== JSON.stringify(activity)) {
    $('activity').dataset.snapshot = JSON.stringify(activity);
    $('activity').replaceChildren(...activity.map((event) => {
      const details = element('details', '');
      const label = event.type === 'jev_decision' ? jevActivityLabel(event.data) : event.type === 'tool_call' ? `↗ ${event.data.name}` : event.type === 'tool_result' ? `✓ ${t('{name} returned', { name: event.data.name })}` : event.type === 'run_error' ? t('Run failed') : t('Response ready');
      details.append(element('summary', '', label), element('pre', '', JSON.stringify(event.data, null, 2)));
      return details;
    }));
    if (!activity.length) $('activity').textContent = t('Tool calls and progress, as they happen.');
  }
}

function settings() {
  const config = current.config;
  $('provider').value = config.provider === 'openai' ? 'openai' : 'kimi';
  $('model').value = config.model;
  $('base-url').value = config.baseURL || 'https://api.moonshot.cn/v1';
  $('api-key').value = '';
  keepSavedKey = config.configured;
  $('api-key').placeholder = keepSavedKey ? t('Leave blank to keep the saved key') : t('Enter your API key');
  $('settings-error').hidden = true;
  $('base-url-field').hidden = $('provider').value === 'openai';
  $('settings').showModal();
}

function renderProgress() {
  $('progress-label').textContent = progressEvent?.type === 'tool_call'
    ? t('Using {name}…', { name: progressEvent.data.name })
    : progressEvent?.type === 'tool_result' ? t('Thinking about the result…') : t('Thinking…');
}

for (const select of document.querySelectorAll('[data-language]')) select.onchange = () => {
  setLanguage(select.value);
  renderedHistory = '';
  delete $('activity').dataset.snapshot;
  if (current) render(current);
  renderProgress();
  $('api-key').placeholder = keepSavedKey ? t('Leave blank to keep the saved key') : t('Enter your API key');
  for (const target of ['error', 'settings-error']) {
    if ($(target).dataset.error) $(target).textContent = t($(target).dataset.error);
  }
};

$('settings-button').onclick = settings;
$('close-settings').onclick = () => $('settings').close();
$('provider').onchange = () => {
  keepSavedKey = false;
  $('base-url-field').hidden = $('provider').value === 'openai';
  $('model').value = '';
  $('api-key').value = '';
  $('api-key').placeholder = t('Enter your API key');
};
$('settings-form').onsubmit = async (event) => {
  event.preventDefault();
  $('save-settings').disabled = true;
  $('settings-error').hidden = true;
  try {
    await api.configure({ provider: $('provider').value, model: $('model').value, baseURL: $('base-url').value, apiKey: $('api-key').value });
    $('api-key').value = '';
    $('settings').close();
    $('error').hidden = true;
    $('prompt').focus();
  } catch (error) { showError(error, 'settings-error'); }
  finally { $('save-settings').disabled = false; }
};
$('chat-form').onsubmit = async (event) => {
  event.preventDefault();
  const value = $('prompt').value.trim();
  if (!value || current.busy || sending) return;
  if (!current.config.configured) return settings();
  sending = true;
  $('error').hidden = true;
  $('prompt').value = '';
  progressEvent = undefined;
  renderProgress();
  render(current);
  try { await api.send(value); }
  catch (error) { showError(error); if (!current.history.some((message) => message.role === 'user' && message.content === value)) $('prompt').value = value; }
  finally { sending = false; render(await api.state()); $('prompt').focus(); }
};
$('prompt').oninput = () => { $('send').disabled = sending || current?.busy || !$('prompt').value.trim(); };
$('prompt').onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('chat-form').requestSubmit();
  }
};
for (const button of document.querySelectorAll('[data-prompt]')) button.onclick = () => { $('prompt').value = button.dataset.prompt; $('prompt').oninput(); $('prompt').focus(); };
$('new-chat').onclick = () => $('reset-dialog').showModal();
$('cancel-reset').onclick = () => $('reset-dialog').close();
$('confirm-reset').onclick = async () => {
  $('reset-dialog').close();
  try { await api.reset(); $('error').hidden = true; $('prompt').focus(); } catch (error) { showError(error); }
};
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'n') { event.preventDefault(); if (!current?.busy) $('new-chat').click(); }
});
$('memory-form').onsubmit = async (event) => {
  event.preventDefault();
  if (current.busy || !$('memory-input').value.trim()) return;
  try { await api.remember($('memory-input').value); $('memory-input').value = ''; } catch (error) { showError(error); }
};
api.onEvent(({ type, data }) => {
  if (type === 'state') render(data);
  if (type === 'trace') { progressEvent = data; renderProgress(); }
});
try { render(await api.state()); if (!current.config.configured) settings(); } catch (error) { showError(error); }
