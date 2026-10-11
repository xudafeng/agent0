import { applyLanguage, setLanguage, t } from './i18n.js';
import { setupMcpSettings } from './mcp-settings.js';
import { setupJevSettings, jevActivityLabel } from './jev-settings.js';
import { setupSkills } from './skills.js';

const $ = (id) => document.getElementById(id);
const api = window.agent0;
let current;
let sending = false;
let renderedHistory = '';
let renderedSessions = '';
let progressEvent;
let keepSavedKey = false;
let backgroundSessionId = '';
let backgroundLoading = false;
let memoryEntries = [];
let memorySearchTimer;
let personalStateCache;
let personalLoading = false;
let autonomyLoading = false;
let autonomyStateCache;

applyLanguage();
const mcpSettings = setupMcpSettings();
const jevSettings = setupJevSettings();
const skills = setupSkills();

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

async function switchSession(id) {
  if (current?.busy || sending || id === current?.activeSessionId) return;
  await api.switchSession(id);
  renderedHistory = '';
  progressEvent = undefined;
  render(await api.state());
  $('prompt').focus();
}

async function renameSession(session, row) {
  if (current?.busy || sending) return;
  const input = element('input', 'session-title-input');
  input.value = session.title;
  input.maxLength = 120;
  row.replaceChildren(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const title = input.value.trim();
    if (save && title && title !== session.title) {
      try { await api.renameSession(session.id, title); }
      catch (error) { showError(error); }
    }
    renderedSessions = '';
    render(await api.state());
  };
  input.onkeydown = (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); void finish(false); }
  };
  input.onblur = () => void finish(true);
}

function renderSessions(state, locked) {
  const snapshot = JSON.stringify([state.sessions, state.activeSessionId, locked]);
  if (snapshot === renderedSessions) return;
  renderedSessions = snapshot;
  const rows = state.sessions.map((session) => {
    const row = element('div', `session-item${session.id === state.activeSessionId ? ' active' : ''}`);
    row.dataset.sessionId = session.id;

    const open = element('button', 'session-open', session.title);
    open.type = 'button';
    open.title = session.title;
    open.disabled = locked;
    open.onclick = () => void switchSession(session.id);

    const rename = element('button', 'session-action', '✎');
    rename.type = 'button';
    rename.title = t('Rename conversation');
    rename.setAttribute('aria-label', t('Rename conversation'));
    rename.disabled = locked;
    rename.onclick = () => void renameSession(session, row);

    const remove = element('button', 'session-action', '×');
    remove.type = 'button';
    remove.title = t('Delete conversation');
    remove.setAttribute('aria-label', t('Delete conversation'));
    remove.disabled = locked;
    remove.onclick = async () => {
      try {
        await api.deleteSession(session.id);
        renderedHistory = '';
        progressEvent = undefined;
        renderedSessions = '';
        render(await api.state());
      } catch (error) { showError(error); }
    };

    row.append(open, rename, remove);
    return row;
  });
  $('session-list').replaceChildren(...rows);
  const active = state.sessions.find((session) => session.id === state.activeSessionId);
  $('active-session-title').textContent = active?.title || t('Conversation');
}




function missionStatusIcon(status) {
  return status === 'completed' ? '✓' : status === 'blocked' ? '!' : status === 'in_progress' ? '◉' : '○';
}

async function openArtifact(artifact) {
  try {
    const result = await api.artifactRead(artifact.id);
    $('artifact-dialog-title').textContent = result.artifact.title;
    $('artifact-dialog-meta').textContent = [result.artifact.kind, result.artifact.id.slice(0, 8)].join(' · ');
    $('artifact-dialog-content').textContent = result.content;
    $('artifact-dialog').showModal();
  } catch (error) {
    showError(error);
  }
}

function renderAutonomyState(state) {
  autonomyStateCache = state;
  const mission = state.activeMission;
  $('autonomy-empty').hidden = Boolean(mission);
  $('autonomy-content').hidden = !mission;
  if (!mission) return;

  $('autonomy-goal').textContent = mission.goal;
  const completed = mission.tasks.filter((task) => task.status === 'completed').length;
  $('autonomy-progress').textContent = `${completed}/${mission.tasks.length} · ${mission.status}`;

  $('autonomy-tasks').replaceChildren(...mission.tasks.map((task) => {
    const row = element('div', 'autonomy-task');
    row.append(
      element('span', `autonomy-task-status ${task.status}`, missionStatusIcon(task.status)),
      element('span', 'autonomy-task-title', task.title),
    );
    if (task.result) row.title = task.result;
    return row;
  }));

  const evaluation = mission.evaluation;
  $('autonomy-evaluation').hidden = !evaluation;
  $('autonomy-evaluation').textContent = evaluation
    ? `Eval ${Math.round(evaluation.score * 100)}% · ${evaluation.summary}`
    : '';

  const handoff = mission.handoff?.status === 'pending' ? mission.handoff : undefined;
  $('autonomy-handoff').hidden = !handoff;
  $('autonomy-handoff-question').textContent = handoff?.question ?? '';
  if (!handoff) $('autonomy-handoff-response').value = '';

  const artifacts = state.artifacts.filter((artifact) => mission.artifactIds.includes(artifact.id));
  $('autonomy-artifacts').replaceChildren(...artifacts.map((artifact) => {
    const button = element('button', 'autonomy-artifact', `↗ ${artifact.title}`);
    button.type = 'button';
    button.onclick = () => void openArtifact(artifact);
    return button;
  }));
}

async function refreshAutonomyState() {
  if (autonomyLoading) return;
  autonomyLoading = true;
  $('autonomy-refresh').disabled = true;
  try {
    renderAutonomyState(await api.autonomyState());
  } catch (error) {
    $('autonomy-empty').hidden = false;
    $('autonomy-content').hidden = true;
    $('autonomy-empty').textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  } finally {
    autonomyLoading = false;
    $('autonomy-refresh').disabled = false;
  }
}

function personalStatusIcon(status) {
  return status === 'completed' ? '✓' : status === 'in_progress' ? '◉' : '○';
}

function renderPersonalState(state) {
  personalStateCache = state;
  $('personal-focus').textContent = state.dailyFocus || 'No daily focus.';
  $('personal-focus').classList.toggle('empty-panel', !state.dailyFocus);

  const activeTasks = state.tasks.filter((task) => task.status !== 'completed').slice(0, 5);
  $('personal-tasks').replaceChildren(...activeTasks.map((task) => {
    const row = element('div', 'personal-row');
    row.append(
      element('span', 'personal-status', personalStatusIcon(task.status)),
      element('span', 'personal-row-text', task.title),
    );
    return row;
  }));

  $('personal-goals').replaceChildren(...state.goals.slice(0, 4).map((goal) => {
    const row = element('div', 'personal-row personal-goal-row');
    row.append(element('span', 'personal-status', '◎'), element('span', 'personal-row-text', goal.title));
    return row;
  }));
}

async function refreshPersonalState() {
  if (personalLoading) return;
  personalLoading = true;
  try {
    renderPersonalState(await api.personalState());
  } catch (error) {
    $('personal-focus').textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
    $('personal-focus').classList.add('empty-panel');
  } finally {
    personalLoading = false;
  }
}

function renderPersonalManager(state) {
  $('personal-focus-input').value = state.dailyFocus;

  $('personal-goal-list').replaceChildren(...state.goals.map((goal) => {
    const row = element('div', 'personal-manager-row');
    row.append(element('span', 'personal-manager-title', goal.title));
    const remove = element('button', 'personal-remove', '×');
    remove.type = 'button';
    remove.title = 'Remove goal';
    remove.onclick = async () => {
      try {
        await api.personalRemoveGoal(goal.id);
        const next = await api.personalState();
        renderPersonalState(next);
        renderPersonalManager(next);
      } catch (error) {
        showError(error);
      }
    };
    row.append(remove);
    return row;
  }));

  const goalOptions = [element('option', '', 'No goal')];
  goalOptions[0].value = '';
  for (const goal of state.goals) {
    const option = element('option', '', goal.title);
    option.value = goal.id;
    goalOptions.push(option);
  }
  $('personal-task-goal').replaceChildren(...goalOptions);

  $('personal-task-list').replaceChildren(...state.tasks.slice().sort((a, b) =>
    a.status === 'completed' && b.status !== 'completed' ? 1 :
    a.status !== 'completed' && b.status === 'completed' ? -1 : 0
  ).map((task) => {
    const row = element('div', 'personal-manager-row');
    const toggle = element('button', 'personal-task-toggle', personalStatusIcon(task.status));
    toggle.type = 'button';
    toggle.title = task.status === 'completed' ? 'Reopen task' : 'Advance task';
    toggle.onclick = async () => {
      const status = task.status === 'pending' ? 'in_progress' : task.status === 'in_progress' ? 'completed' : 'pending';
      try {
        await api.personalUpdateTask({ id: task.id, status });
        const next = await api.personalState();
        renderPersonalState(next);
        renderPersonalManager(next);
      } catch (error) {
        showError(error);
      }
    };
    const body = element('span', 'personal-manager-title', task.title);
    if (task.status === 'completed') body.classList.add('completed');
    row.append(toggle, body);
    return row;
  }));
}

function formatBackgroundTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

function backgroundStateBadge(state) {
  return state === 'succeeded' ? '✓' : state === 'failed' ? '!' : state === 'running' || state === 'starting' ? '●' : state === 'cancelled' ? '⊘' : '○';
}

async function openJobOutput(job) {
  try {
    const output = await api.jobOutput(job.jobId);
    $('background-job-title').textContent = `Job ${job.jobId.slice(0, 8)}`;
    $('background-job-meta').textContent = [job.state, job.exitCode === undefined ? '' : `exit ${job.exitCode}`].filter(Boolean).join(' · ');
    $('background-job-stdout').textContent = output.stdout || '(empty)';
    $('background-job-stderr').textContent = output.stderr || '(empty)';
    $('background-job-dialog').showModal();
  } catch (error) {
    showError(error);
  }
}

function renderBackground(data) {
  const schedules = data?.schedules ?? [];
  const jobs = data?.jobs ?? [];
  $('background-next').textContent = data?.nextWakeAt
    ? `Next wake · ${formatBackgroundTime(data.nextWakeAt)}`
    : data?.configured ? 'No pending schedules.' : 'Configure a computer backend to use background work.';
  $('background-next').classList.toggle('empty-panel', !data?.nextWakeAt);

  $('background-schedules').replaceChildren(...schedules.slice(0, 6).map((schedule) => {
    const row = element('div', 'background-row');
    const body = element('div', 'background-row-body');
    const kind = schedule.cronExpression
      ? `${schedule.cronExpression} · ${schedule.timeZone}`
      : schedule.repeatEveryMs
        ? `Every ${Math.round(schedule.repeatEveryMs / 1000)}s`
        : 'One-shot';
    body.append(
      element('strong', '', `${backgroundStateBadge(schedule.state)} ${kind}`),
      element('small', '', `${schedule.state} · ${formatBackgroundTime(schedule.runAt)}`),
    );
    row.append(body);
    if (schedule.state === 'pending') {
      const cancel = element('button', 'background-action', '×');
      cancel.type = 'button';
      cancel.title = 'Cancel schedule';
      cancel.onclick = async () => {
        try {
          await api.cancelSchedule(schedule.scheduleId);
          await refreshBackground();
        } catch (error) {
          showError(error);
        }
      };
      row.append(cancel);
    }
    return row;
  }));

  $('background-jobs').replaceChildren(...jobs.slice(0, 6).map((job) => {
    const button = element('button', 'background-row background-job');
    button.type = 'button';
    const body = element('div', 'background-row-body');
    body.append(
      element('strong', '', `${backgroundStateBadge(job.state)} Job ${job.jobId.slice(0, 8)}`),
      element('small', '', [job.state, job.exitCode === undefined ? '' : `exit ${job.exitCode}`].filter(Boolean).join(' · ')),
    );
    button.append(body, element('span', 'background-chevron', '›'));
    button.onclick = () => void openJobOutput(job);
    return button;
  }));

  if (!schedules.length) $('background-schedules').replaceChildren();
  if (!jobs.length) $('background-jobs').replaceChildren();
}

async function refreshBackground() {
  if (backgroundLoading || !current) return;
  backgroundLoading = true;
  $('background-refresh').disabled = true;
  try {
    renderBackground(await api.backgroundState());
  } catch (error) {
    $('background-next').textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
    $('background-next').classList.add('empty-panel');
  } finally {
    backgroundLoading = false;
    $('background-refresh').disabled = false;
  }
}


function memoryScopeLabel(scope) {
  const labels = {
    profile: t('Profile'),
    preferences: t('Preferences'),
    projects: t('Projects'),
    working: t('Working memory'),
    general: t('General'),
  };
  return labels[scope] ?? scope;
}

function memoryCard(entry) {
  const card = element('article', 'memory-card');
  card.dataset.memoryId = entry.id;
  const head = element('div', 'memory-card-head');
  head.append(
    element('span', 'memory-scope-badge', memoryScopeLabel(entry.scope)),
    element('code', 'memory-id', entry.id.slice(0, 8)),
  );

  const content = element('div', 'memory-card-content', entry.content);
  const actions = element('div', 'memory-card-actions');
  const edit = element('button', 'secondary', t('Edit'));
  edit.type = 'button';
  const remove = element('button', 'memory-delete', t('Delete'));
  remove.type = 'button';

  edit.onclick = () => {
    const textarea = element('textarea', 'memory-edit-content');
    textarea.value = entry.content;
    textarea.maxLength = 4000;

    const scope = element('select', 'memory-edit-scope');
    for (const value of ['profile', 'preferences', 'projects', 'working', 'general']) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = memoryScopeLabel(value);
      option.selected = value === entry.scope;
      scope.append(option);
    }

    const editorActions = element('div', 'memory-card-actions');
    const cancel = element('button', 'secondary', t('Cancel'));
    cancel.type = 'button';
    const save = element('button', 'primary', t('Save'));
    save.type = 'button';
    cancel.onclick = () => refreshMemoryManager();
    save.onclick = async () => {
      const value = textarea.value.trim();
      if (!value) return;
      save.disabled = true;
      try {
        await api.memoryUpdate(entry.id, value, scope.value);
        await refreshMemoryManager();
        render(await api.state());
      } catch (error) {
        showError(error);
      } finally {
        save.disabled = false;
      }
    };
    editorActions.append(cancel, save);
    card.replaceChildren(head, scope, textarea, editorActions);
    textarea.focus();
  };

  remove.onclick = async () => {
    remove.disabled = true;
    try {
      await api.memoryForget(entry.id);
      await refreshMemoryManager();
      render(await api.state());
    } catch (error) {
      showError(error);
      remove.disabled = false;
    }
  };

  actions.append(edit, remove);
  card.append(head, content, actions);
  return card;
}

function renderMemoryManager(entries) {
  memoryEntries = entries;
  $('memory-list').replaceChildren(...entries.map(memoryCard));
  if (!entries.length) {
    $('memory-list').append(element('div', 'empty-panel', t('No memory found.')));
  }
}

async function refreshMemoryManager() {
  const query = $('memory-search').value.trim();
  const scope = $('memory-filter').value || undefined;
  try {
    const entries = query
      ? await api.memorySearch(query, scope)
      : await api.memoryList(scope);
    renderMemoryManager(entries);
  } catch (error) {
    showError(error);
  }
}

function render(state) {
  current = state;
  const { config, history, busy, task, memory, events, approval } = state;
  const locked = busy || sending;
  mcpSettings.setBusy(locked);
  skills.render(locked);
  jevSettings.render(config.jev, locked);
  $('connection-label').textContent = busy ? t('Working') : config.configured ? t('Ready') : t('Setup needed');
  $('model-label').textContent = config.model || t('Connect a model to get started');
  $('send').disabled = locked || !$('prompt').value.trim();
  $('stop').hidden = !busy;
  $('stop').disabled = !busy;
  $('new-chat').disabled = locked;
  renderSessions(state, locked);
  if (backgroundSessionId !== state.activeSessionId) {
    backgroundSessionId = state.activeSessionId;
    void refreshBackground();
  }
  $('settings-button').disabled = locked;
  $('memory-input').disabled = locked;
  $('memory-form').querySelector('button').disabled = locked;
  $('progress').hidden = !busy;
  $('welcome').hidden = history.length > 0;
  if (approval) {
    $('tool-approval-reason').textContent = t(approval.reason);
    $('tool-approval-name').textContent = approval.name;
    $('tool-approval-arguments').textContent = JSON.stringify(approval.arguments, null, 2);
    $('tool-approve').disabled = false;
    $('tool-deny').disabled = false;
    if (!$('tool-approval').open) $('tool-approval').showModal();
  } else if ($('tool-approval').open) {
    $('tool-approval').close();
  }
  renderProgress();
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
  const activity = events.filter((event) => ['jev_decision', 'tool_approval_requested', 'tool_approval_resolved', 'tool_blocked', 'tool_start', 'tool_end', 'run_cancelled', 'run_error', 'run_end'].includes(event.type));
  $('activity-count').textContent = activity.length;
  // Avoid rebuilding activity details when only unrelated state changes.
  if ($('activity').dataset.snapshot !== JSON.stringify(activity)) {
    $('activity').dataset.snapshot = JSON.stringify(activity);
    $('activity').replaceChildren(...activity.map((event) => {
      const details = element('details', '');
      const label = event.type === 'jev_decision' ? jevActivityLabel(event.decision) : event.type === 'tool_approval_requested' ? `? ${t('{name} needs approval', { name: event.toolCall.name })}` : event.type === 'tool_approval_resolved' ? `${event.approved ? '✓' : '⊘'} ${t(event.approved ? '{name} approved' : '{name} denied', { name: event.toolCall.name })}` : event.type === 'tool_blocked' ? `⊘ ${t('{name} blocked', { name: event.toolCall.name })}` : event.type === 'tool_start' ? `↗ ${event.toolCall.name}` : event.type === 'tool_end' ? `${event.isError ? '!' : '✓'} ${t('{name} returned', { name: event.name })}` : event.type === 'run_cancelled' ? t('Run stopped') : event.type === 'run_error' ? t('Run failed') : t('Response ready');
      details.append(element('summary', '', label), element('pre', '', JSON.stringify(event, null, 2)));
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
  if (current?.approval) {
    $('progress-label').textContent = t('Waiting for approval…');
    return;
  }
  $('progress-label').textContent = progressEvent?.type === 'tool_start'
    ? t('Using {name}…', { name: progressEvent.toolCall.name })
    : progressEvent?.type === 'tool_end' ? t('Thinking about the result…') : t('Thinking…');
}

for (const select of document.querySelectorAll('[data-language]')) select.onchange = () => {
  setLanguage(select.value);
  renderedHistory = '';
  renderedSessions = '';
  delete $('activity').dataset.snapshot;
  if (current) render(current);
  renderProgress();
  $('api-key').placeholder = keepSavedKey ? t('Leave blank to keep the saved key') : t('Enter your API key');
  for (const target of ['error', 'settings-error']) {
    if ($(target).dataset.error) $(target).textContent = t($(target).dataset.error);
  }
};

async function resolveApproval(approved) {
  const approval = current?.approval;
  if (!approval) return;
  $('tool-approve').disabled = true;
  $('tool-deny').disabled = true;
  try { await api.resolveApproval(approval.id, approved); }
  catch (error) { showError(error); }
}

$('tool-approve').onclick = () => resolveApproval(true);
$('tool-deny').onclick = () => resolveApproval(false);

$('stop').onclick = async () => {
  $('stop').disabled = true;
  try { await api.abort(); } catch (error) { showError(error); }
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
$('new-chat').onclick = async () => {
  try {
    await api.createSession();
    renderedHistory = '';
    renderedSessions = '';
    progressEvent = undefined;
    $('error').hidden = true;
    render(await api.state());
    $('prompt').focus();
  } catch (error) { showError(error); }
};
$('cancel-reset').onclick = () => $('reset-dialog').close();
$('confirm-reset').onclick = async () => {
  $('reset-dialog').close();
  $('new-chat').click();
};
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'n') { event.preventDefault(); if (!current?.busy) $('new-chat').click(); }
});
$('memory-form').onsubmit = async (event) => {
  event.preventDefault();
  if (current.busy || !$('memory-input').value.trim()) return;
  try {
    await api.memoryAdd($('memory-input').value, $('memory-scope').value);
    $('memory-input').value = '';
    render(await api.state());
    if ($('memory-dialog').open) await refreshMemoryManager();
  } catch (error) {
    showError(error);
  }
};

$('memory-manage').onclick = async () => {
  $('memory-search').value = '';
  $('memory-filter').value = '';
  await refreshMemoryManager();
  $('memory-dialog').showModal();
};
$('close-memory-dialog').onclick = () => $('memory-dialog').close();
$('memory-filter').onchange = () => void refreshMemoryManager();
$('memory-search').oninput = () => {
  clearTimeout(memorySearchTimer);
  memorySearchTimer = setTimeout(() => void refreshMemoryManager(), 150);
};
$('autonomy-refresh').onclick = () => void refreshAutonomyState();
$('close-artifact-dialog').onclick = () => $('artifact-dialog').close();
$('autonomy-handoff').onsubmit = async (event) => {
  event.preventDefault();
  const mission = autonomyStateCache?.activeMission;
  const response = $('autonomy-handoff-response').value.trim();
  if (!mission || !response) return;
  const button = $('autonomy-handoff').querySelector('button');
  button.disabled = true;
  try {
    await api.resolveHandoff(mission.id, response);
    $('autonomy-handoff-response').value = '';
    await refreshAutonomyState();
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
  }
};

$('personal-manage').onclick = async () => {
  const state = await api.personalState();
  renderPersonalState(state);
  renderPersonalManager(state);
  $('personal-dialog').showModal();
};
$('close-personal-dialog').onclick = () => $('personal-dialog').close();
$('personal-focus-save').onclick = async () => {
  try {
    const state = await api.personalSetFocus($('personal-focus-input').value);
    renderPersonalState(state);
    renderPersonalManager(state);
  } catch (error) {
    showError(error);
  }
};
$('personal-goal-form').onsubmit = async (event) => {
  event.preventDefault();
  const title = $('personal-goal-input').value.trim();
  if (!title) return;
  try {
    await api.personalAddGoal(title);
    $('personal-goal-input').value = '';
    const state = await api.personalState();
    renderPersonalState(state);
    renderPersonalManager(state);
  } catch (error) {
    showError(error);
  }
};
$('personal-task-form').onsubmit = async (event) => {
  event.preventDefault();
  const title = $('personal-task-input').value.trim();
  if (!title) return;
  try {
    await api.personalAddTask(title, $('personal-task-goal').value || undefined);
    $('personal-task-input').value = '';
    const state = await api.personalState();
    renderPersonalState(state);
    renderPersonalManager(state);
  } catch (error) {
    showError(error);
  }
};

$('background-refresh').onclick = () => void refreshBackground();
$('close-background-job').onclick = () => $('background-job-dialog').close();

api.onEvent(({ type, data }) => {
  if (type === 'state') render(data);
  if (type === 'agent') {
    progressEvent = data;
    renderProgress();
    if (data.type === 'run_end' || data.type === 'run_error' || data.type === 'run_cancelled') {
      void refreshBackground();
      void refreshPersonalState();
      void refreshAutonomyState();
    }
  }
});
try {
  render(await api.state());
  await Promise.all([refreshPersonalState(), refreshAutonomyState()]);
  if (!current.config.configured) settings();
} catch (error) {
  showError(error);
}
