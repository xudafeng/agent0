const chinese = {
  'DESKTOP': '桌面版',
  'New conversation': '新对话',
  'WORKSPACE': '工作区',
  'Conversation': '对话',
  'Your space to think,': '在这里思考、',
  'plan, and get things done.': '规划，让想法落地。',
  'Runs on your computer': '在本机运行',
  'Model settings': '模型设置',
  'Workspace /': '工作区 /',
  'Ready': '就绪',
  'A LITTLE HELP. A LOT OF POSSIBILITY.': '一点帮助，无限可能。',
  'What are we working on?': '今天想做些什么？',
  'Bring an idea, a question, or a task.': '带来一个想法、问题或任务，',
  'Your agent will take it from here.': '接下来交给你的智能助手。',
  'Make a plan': '制定计划',
  'Turn a goal into clear next steps': '把目标变成清晰的行动步骤',
  'Explore your tools': '探索工具',
  'See what your agent can do': '了解智能助手能做什么',
  'Think it through': '梳理思路',
  'Find a fresh perspective': '发现新的思考角度',
  'Thinking…': '思考中…',
  'Configure your model': '配置模型',
  'Enter to send · Shift + Enter for a new line': 'Enter 发送 · Shift + Enter 换行',
  'Powered by your model. Guided by you.': '由你的模型驱动，由你掌握方向。',
  'Agent workspace': '智能助手工作区',
  'Task plan': '任务计划',
  'A little structure goes a long way.': '清晰的步骤，让行动更有方向。',
  'Your task plan will appear here.': '任务计划会显示在这里。',
  'Activity': '活动',
  'Tool calls and progress,': '工具调用与进度，',
  'as they happen.': '实时呈现。',
  'Memory': '记忆',
  'Save useful context for future conversations.': '保存有用的信息，供后续对话使用。',
  'Stored locally across conversations.': '保存在本机，可跨对话使用。',
  'LESS FRICTION. MORE DOING.': '少些阻碍，多些行动。',
  'MAKE IT YOURS': '按你的方式配置',
  'Connect your model': '连接模型',
  'Use your own API key to get started. Settings are saved on this computer.': '使用你自己的 API 密钥开始，设置会保存在本机。',
  'Provider': '服务商',
  'Model': '模型',
  'Base URL': '服务地址',
  'API key': 'API 密钥',
  'Keys are stored in a local .env file and sent only to your selected provider. Saving starts a new conversation.': '密钥保存在本机 .env 文件中，仅发送给你选择的服务商。保存后将开始新对话。',
  'Save settings': '保存设置',
  'Start a new conversation?': '开始新对话？',
  'This clears the current chat and task plan. Your saved memory stays.': '当前对话和任务计划将被清除，已保存的记忆会保留。',
  'Keep chatting': '继续当前对话',
  'Ask anything, or describe a task…': '输入问题，或描述一个任务…',
  'Message': '消息',
  'Send message': '发送消息',
  'Something to remember…': '记住一些有用的信息…',
  'Memory to save': '要保存的记忆',
  'Save memory': '保存记忆',
  'Close settings': '关闭设置',
  'Model ID from your provider': '服务商提供的模型 ID',
  'Enter your API key': '输入 API 密钥',
  'Help me plan my day. Ask me about my priorities first.': '帮我安排今天的计划，请先询问我的优先事项。',
  'What tools can you use? Give me a short overview and a simple example.': '你可以使用哪些工具？请简要介绍，并给出一个简单示例。',
  'Help me break down a complex problem. Ask me what I am trying to solve.': '帮我拆解一个复杂问题，请先询问我想解决什么。',
  'Working': '处理中',
  'Setup needed': '需要配置',
  'Connect a model to get started': '连接模型后开始使用',
  'You': '你',
  'Something went wrong': '出现了问题',
  'Completed in {count} step': '共完成 {count} 个步骤',
  'Completed in {count} steps': '共完成 {count} 个步骤',
  'A little structure goes a long way. Your task plan will appear here.': '清晰的步骤，让行动更有方向。任务计划会显示在这里。',
  'Tool calls and progress, as they happen.': '实时展示工具调用与进度。',
  '{name} returned': '{name} 已返回结果',
  'Run failed': '运行失败',
  'Response ready': '回复已就绪',
  'Leave blank to keep the saved key': '留空以保留已保存的密钥',
  'Using {name}…': '正在使用 {name}…',
  'Thinking about the result…': '正在分析结果…',
  'Language': '界面语言',
  'Wait for the current operation to finish.': '请等待当前操作完成。',
  'Choose a provider.': '请选择服务商。',
  'Enter an API key.': '请输入 API 密钥。',
  'Use an HTTP or HTTPS base URL.': '服务地址需要以 HTTP 或 HTTPS 开头。',
  'Configuration contains unsupported characters.': '配置包含不支持的字符。',
  'Invalid model.': '模型无效。',
  'Invalid API key.': 'API 密钥无效。',
  'Invalid base URL.': '服务地址无效。',
  'Invalid message.': '消息无效。',
  'Invalid memory.': '记忆内容无效。'
};

let language = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
try {
  const saved = localStorage.getItem('agent0.language');
  if (saved === 'en' || saved === 'zh') language = saved;
} catch { /* Keep the browser default when storage is unavailable. */ }

export function t(source, values = {}) {
  const text = language === 'zh' && Object.hasOwn(chinese, source) ? chinese[source] : source;
  return text.replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(values, key) ? values[key] : match);
}

export function applyLanguage() {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const attribute of ['placeholder', 'title', 'aria-label', 'data-prompt']) {
    for (const node of document.querySelectorAll(`[data-i18n-${attribute}]`)) {
      node.setAttribute(attribute, t(node.getAttribute(`data-i18n-${attribute}`)));
    }
  }
  for (const select of document.querySelectorAll('[data-language]')) select.value = language;
}

export function setLanguage(value) {
  if (value !== 'en' && value !== 'zh') return;
  language = value;
  try { localStorage.setItem('agent0.language', language); } catch { /* Switching still works without storage. */ }
  applyLanguage();
}
