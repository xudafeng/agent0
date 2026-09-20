import { t } from './i18n.js';

export function setupSkills() {
  const $ = (id) => document.getElementById(id);
  let catalog;
  let loading = false;
  let busy = false;

  function node(tag, value, className = '') {
    const element = document.createElement(tag);
    element.textContent = value;
    element.className = className;
    return element;
  }

  function render(locked = busy) {
    busy = locked;
    $('skills-button').disabled = busy || loading;
    $('skills-refresh').disabled = busy || loading;
    if (!catalog) return;
    $('skills-directories').textContent = catalog.directories.join('\n') || t('Skill discovery is disabled.');
    $('skills-list').replaceChildren(...catalog.skills.map((skill) => {
      const card = node('article', '', 'skill-card');
      card.append(node('h3', skill.name), node('span', t(catalog.loaded.includes(skill.name) ? 'Loaded' : 'Available'), 'muted'),
        node('p', skill.description), node('code', skill.path));
      const use = node('button', t('Use skill'), 'secondary');
      use.disabled = busy || loading;
      use.onclick = () => {
        const prompt = $('prompt');
        prompt.value = `$${skill.name} ${prompt.value}`;
        prompt.dispatchEvent(new Event('input'));
        $('skills-dialog').close();
        prompt.focus();
      };
      card.append(use);
      return card;
    }));
    if (!catalog.skills.length) $('skills-list').append(node('p', t('No skills found.')));
    $('skills-diagnostics').hidden = !catalog.diagnostics.length;
    $('skills-diagnostics-text').textContent = catalog.diagnostics.join('\n');
  }

  async function refresh() {
    loading = true;
    $('skills-error').hidden = true;
    render();
    try { catalog = await window.agent0.skillsList(); }
    catch (error) {
      $('skills-error').textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
      $('skills-error').hidden = false;
    } finally { loading = false; render(); }
  }

  $('skills-button').onclick = () => { $('skills-dialog').showModal(); void refresh(); };
  $('skills-refresh').onclick = refresh;
  $('close-skills').onclick = () => $('skills-dialog').close();
  return { render };
}
