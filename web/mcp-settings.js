import { t } from './i18n.js';

const $ = (id) => document.getElementById(id);
const api = window.agent0;

function node(tag, text, className = '') {
  const element = document.createElement(tag);
  element.textContent = text;
  element.className = className;
  return element;
}

export function setupMcpSettings() {
  let servers = [];
  let selected = -1;
  let busy = false;
  let pending = false;
  let status = '';
  let tools = [];
  let errorMessage = '';
  let filesystem = false;
  const connectivity = new Map();
  const connectionLabels = {
    checking: 'Checking…', reachable: 'Reachable', failed: 'Connection failed',
    disabled: 'Disabled', unchecked: 'Not checked',
  };

  async function checkSaved(id) {
    const targets = servers.filter((server) => id === undefined || server.id === id);
    for (const server of targets) connectivity.set(server.id, { status: server.enabled ? 'checking' : 'disabled' });
    render();
    try {
      for (const result of await api.mcpCheck(id)) connectivity.set(result.id, result);
    } catch (error) {
      for (const server of targets) {
        if (server.enabled) connectivity.set(server.id, { status: 'unchecked' });
      }
      throw error;
    } finally { render(); }
  }

  function lock() {
    $('mcp-button').disabled = busy || pending;
    for (const control of $('mcp-settings').querySelectorAll('input, textarea, select, button')) control.disabled = busy || pending;
  }

  function render() {
    $('mcp-list').replaceChildren();
    if (!servers.length) $('mcp-list').append(node('p', t('No external servers yet.'), 'muted'));
    servers.forEach((server, index) => {
      const row = node('div', '', `mcp-server${selected === index ? ' selected' : ''}`);
      const edit = node('button', server.builtin ? t('Filesystem · built-in') : server.id, 'mcp-server-name');
      edit.type = 'button';
      edit.onclick = () => editServer(index);
      const connection = server.enabled ? connectivity.get(server.id) || { status: 'unchecked' } : { status: 'disabled' };
      row.dataset.serverId = server.id;
      row.dataset.connection = connection.status;
      row.append(edit, node('small', t(connectionLabels[connection.status]), `mcp-connection ${connection.status}`));
      if (server.builtin) row.append(node('small', server.directory, 'mcp-folder-path'));
      if (server.url) row.append(node('small', server.transport === 'sse' ? 'SSE' : 'HTTP', 'mcp-check-info'));
      if (connection.status === 'reachable') row.append(node('small', t('{count} tools · {ms} ms', { count: connection.toolCount, ms: connection.durationMs }), 'mcp-check-info'));
      if (connection.checkedAt) {
        const time = new Date(connection.checkedAt).toLocaleTimeString(document.documentElement.lang);
        row.append(node('small', t('Checked at {time}', { time }), 'mcp-check-info'));
      }
      if (connection.error) {
        const details = node('details', '', 'mcp-connection-error');
        details.append(node('summary', t('Error details')), node('p', connection.error));
        row.append(details);
      }
      const actions = node('div', '', 'mcp-server-actions');
      const toggle = node('button', t(server.enabled ? 'Disable' : 'Enable'));
      toggle.onclick = () => operate(async () => {
        const next = servers.map((item, i) => i === index ? { ...item, enabled: !item.enabled } : item);
        await api.mcpSave(next);
        servers = next;
        if (selected === index) $('mcp-enabled').checked = next[index].enabled;
        status = 'Saved. Changes apply to the next conversation.';
        await checkSaved(server.id);
      });
      const remove = node('button', t('Remove'));
      remove.onclick = () => operate(async () => {
        const next = servers.filter((_, i) => i !== index);
        await api.mcpSave(next);
        servers = next;
        connectivity.delete(server.id);
        editServer(-1);
        status = 'Saved. Changes apply to the next conversation.';
      });
      actions.append(toggle, remove);
      row.append(actions);
      $('mcp-list').append(row);
    });
    $('mcp-result').textContent = status ? t(status, { count: tools.length }) : '';
    $('mcp-error').textContent = t(errorMessage);
    $('mcp-error').hidden = !errorMessage;
    $('mcp-tools').replaceChildren(...tools.map((tool) => {
      const details = node('details', '');
      details.append(node('summary', tool.name), node('p', tool.description), node('pre', JSON.stringify(tool.parameters, null, 2)));
      return details;
    }));
    lock();
  }

  function editServer(index) {
    selected = index;
    const server = servers[index] || { id: '', command: '', args: [], env: {}, cwd: '', enabled: true };
    filesystem = server.builtin === 'filesystem';
    $('mcp-transport').value = server.transport || 'stdio';
    $('mcp-url').value = server.url || '';
    $('mcp-headers').value = JSON.stringify(server.headers || {}, null, 2);
    for (const key of ['id', 'command', 'cwd']) $(`mcp-${key}`).value = server[key] || '';
    $('mcp-args').value = JSON.stringify(server.args || [], null, 2);
    $('mcp-env').value = JSON.stringify(server.env || {}, null, 2);
    $('mcp-directory').value = server.directory || '';
    $('mcp-enabled').checked = server.enabled;
    showFields();
    status = '';
    tools = [];
    errorMessage = '';
    render();
  }

  function showFields() {
    const remote = !filesystem && $('mcp-transport').value !== 'stdio';
    $('mcp-filesystem-fields').hidden = !filesystem;
    for (const label of document.querySelectorAll('[data-mcp-external]')) label.hidden = filesystem;
    for (const label of document.querySelectorAll('[data-mcp-stdio]')) label.hidden = filesystem || remote;
    $('mcp-remote-fields').hidden = !remote;
    $('mcp-id').required = !filesystem;
    $('mcp-command').required = !filesystem && !remote;
    $('mcp-url').required = remote;
    $('mcp-url').type = remote ? 'url' : 'text';
  }

  function draft() {
    if (filesystem) {
      const directory = $('mcp-directory').value;
      if (!directory) throw new Error('Choose a folder first.');
      return { id: 'builtin-filesystem', builtin: 'filesystem', directory, enabled: $('mcp-enabled').checked };
    }
    const transport = $('mcp-transport').value;
    if (transport !== 'stdio') {
      let headers;
      try { headers = JSON.parse($('mcp-headers').value); }
      catch { throw new Error('Request headers must be a valid JSON object.'); }
      return { id: $('mcp-id').value.trim(), transport, url: $('mcp-url').value.trim(), headers, enabled: $('mcp-enabled').checked };
    }
    let args;
    let env;
    try { args = JSON.parse($('mcp-args').value); env = JSON.parse($('mcp-env').value); }
    catch { throw new Error('Arguments and environment variables must be valid JSON.'); }
    return { id: $('mcp-id').value.trim(), command: $('mcp-command').value.trim(), args, env, cwd: $('mcp-cwd').value.trim(), enabled: $('mcp-enabled').checked };
  }

  async function operate(action) {
    if (pending || busy) return;
    pending = true;
    errorMessage = '';
    render();
    try { await action(); }
    catch (error) {
      errorMessage = error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
      status = '';
    } finally { pending = false; render(); }
  }

  $('mcp-button').onclick = () => operate(async () => {
    $('mcp-settings').showModal();
    servers = await api.mcpList();
    editServer(servers.length ? 0 : -1);
    await checkSaved();
  });
  $('mcp-refresh').onclick = () => operate(() => checkSaved());
  $('mcp-filesystem').onclick = () => {
    editServer(servers.findIndex((server) => server.builtin === 'filesystem'));
    filesystem = true;
    showFields();
  };
  $('mcp-pick-directory').onclick = () => operate(async () => {
    const directory = await api.mcpPickDirectory();
    if (directory) {
      $('mcp-directory').value = directory;
      tools = [];
      status = '';
    }
  });
  $('close-mcp').onclick = () => $('mcp-settings').close();
  $('mcp-settings').addEventListener('cancel', (event) => { if (pending || busy) event.preventDefault(); });
  $('mcp-add').onclick = () => { editServer(-1); $('mcp-id').focus(); };
  $('mcp-form').oninput = () => { tools = []; status = ''; errorMessage = ''; render(); };
  $('mcp-transport').onchange = () => { showFields(); tools = []; status = ''; errorMessage = ''; render(); };
  $('mcp-form').onsubmit = (event) => {
    event.preventDefault();
    const server = draftSafely();
    if (!server) return;
    void operate(async () => {
      const next = [...servers];
      if (selected < 0) next.push(server);
      else next[selected] = server;
      await api.mcpSave(next);
      if (selected >= 0) connectivity.delete(servers[selected].id);
      servers = next;
      selected = next.indexOf(server);
      status = 'Saved. Changes apply to the next conversation.';
      await checkSaved(server.id);
    });
  };
  function draftSafely() {
    try { return draft(); }
    catch (error) { errorMessage = error.message; render(); return null; }
  }
  $('mcp-test').onclick = () => {
    if (!$('mcp-form').reportValidity()) return;
    const server = draftSafely();
    if (!server) return;
    tools = [];
    status = 'Testing connection…';
    void operate(async () => {
      const saved = servers.find((item) => JSON.stringify(item) === JSON.stringify(server));
      const track = saved?.enabled;
      const started = performance.now();
      if (track) { connectivity.set(server.id, { status: 'checking' }); render(); }
      try {
        tools = await api.mcpTest(server);
        if (track) connectivity.set(server.id, { status: 'reachable', checkedAt: Date.now(), durationMs: Math.round(performance.now() - started), toolCount: tools.length });
        status = 'Connection successful. {count} tools available.';
      } catch (error) {
        if (track) connectivity.set(server.id, { status: 'failed', checkedAt: Date.now(), error: error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') });
        throw error;
      }
    });
  };
  document.addEventListener('languagechange', render);
  return { setBusy(value) { busy = value; lock(); } };
}
