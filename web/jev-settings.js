import { t } from './i18n.js';

export function setupJevSettings() {
  const $ = (id) => document.getElementById(id);
  let config;
  $('jev-button').onclick = () => {
    $('jev-enabled').checked = config.enabled;
    $('jev-model').value = config.model;
    $('jev-confidence').value = config.minConfidence;
    $('jev-key').value = '';
    $('jev-key').placeholder = t(config.configured ? 'Leave blank to keep the saved key' : 'Enter your API key');
    $('jev-error').hidden = true;
    $('jev-settings').showModal();
  };
  $('close-jev').onclick = () => $('jev-settings').close();
  $('jev-settings').addEventListener('close', () => { $('jev-key').value = ''; });
  $('jev-form').onsubmit = async (event) => {
    event.preventDefault();
    $('jev-save').disabled = true;
    $('jev-error').hidden = true;
    try {
      await window.agent0.jevSave({ enabled: $('jev-enabled').checked, model: $('jev-model').value,
        apiKey: $('jev-key').value, minConfidence: Number($('jev-confidence').value) });
      $('jev-settings').close();
    } catch (error) {
      $('jev-error').textContent = t(error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
      $('jev-error').hidden = false;
    } finally { $('jev-save').disabled = false; }
  };
  return {
    render(value, busy) {
      config = value;
      $('jev-button').disabled = busy;
      $('jev-save').disabled = busy;
      $('jev-status').textContent = t(value.enabled ? (value.configured ? 'Enabled' : 'Setup needed') : 'Disabled');
    },
  };
}

export function jevActivityLabel(data) {
  const action = data.status === 'selected' ? t('Jev selected {name}', { name: data.selectedTool }) : t('Jev deferred to main model');
  const confidence = typeof data.confidence === 'number' ? ` · ${t('Confidence')} ${Math.round(data.confidence * 100)}%` : '';
  return `${action}${confidence} · ${data.durationMs} ms`;
}
