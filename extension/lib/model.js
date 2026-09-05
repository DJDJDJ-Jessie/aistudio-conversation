export const uid = () => crypto.randomUUID();
export const DEFAULT_SYSTEM = { mode: 'custom', text: '', preset: '' };
export const now = () => new Date().toISOString();
export function newTurn(title = '') {
  return { id: uid(), title, text: '', attachments: [], result: null };
}
export function newConversation(index = 1) {
  return { id: uid(), title: `对话 ${index}`, model: '', system: null, turns: [newTurn('第 1 轮')] };
}
export function newGroup(name = '未命名拆书组') {
  return { id: uid(), name, model: 'gemini-2.5-pro', system: { ...DEFAULT_SYSTEM },
    timeoutMinutes: 20, focusIntervalSeconds: 10, exportMode: 'plain', conversations: [newConversation()],
    run: null, createdAt: now(), updatedAt: now(), revision: 0 };
}
export function counts(group) {
  const turns = group.conversations.flatMap(c => c.turns);
  return { conversations: group.conversations.length, total: turns.length,
    complete: turns.filter(t => t.result).length,
    images: turns.reduce((n,t) => n + t.attachments.length, 0) };
}
export function nextPending(group) {
  for (let ci = 0; ci < group.conversations.length; ci++) {
    for (let ti = 0; ti < group.conversations[ci].turns.length; ti++) {
      if (!group.conversations[ci].turns[ti].result) return { ci, ti };
    }
  }
  return null;
}
export function settingsFor(group, conversation) {
  return { model: conversation.model || group.model, system: conversation.system || group.system };
}
export function validateGroup(group) {
  if (!group.name.trim()) throw new Error('请先填写组名称。');
  if (!group.conversations.length) throw new Error('请至少添加一个对话。');
  if (!Number.isFinite(group.timeoutMinutes) || group.timeoutMinutes < 1 || group.timeoutMinutes > 120)
    throw new Error('每轮等待上限需要在 1–120 分钟之间。');
  if (!Number.isFinite(group.focusIntervalSeconds ?? 10) || (group.focusIntervalSeconds ?? 10) < 2 || (group.focusIntervalSeconds ?? 10) > 120)
    throw new Error('AI Studio 置顶间隔需要在 2–120 秒之间。');
  for (const [ci, c] of group.conversations.entries()) {
    if (!c.turns.length) throw new Error(`对话 ${ci+1} 还没有轮次。`);
    const config = settingsFor(group, c);
    if (!config.model.trim()) throw new Error(`请为对话 ${ci+1} 选择模型。`);
    if (config.system.mode === 'preset' && !config.system.preset.trim()) throw new Error(`对话 ${ci+1} 的系统指令预设名称为空。`);
    for (const [ti,t] of c.turns.entries()) {
      if (!t.text.trim() && !t.attachments.length) throw new Error(`对话 ${ci+1} · 第 ${ti+1} 轮还没有文字或图片。`);
    }
  }
}
export function filename(name, extension = 'md') {
  let stem = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120) || '拆书结果';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = '_' + stem;
  return `${stem}.${extension}`;
}
export function assembleMarkdown(group) {
  const pieces = [];
  if (group.exportMode === 'headings') pieces.push(`# ${group.name.replace(/[\r\n]+/g,' ')}`);
  for (const [ci,c] of group.conversations.entries()) {
    if (group.exportMode === 'headings' && c.turns.some(t => t.result)) pieces.push(`## ${c.title || `对话 ${ci+1}`}`);
    for (const [ti,t] of c.turns.entries()) {
      if (!t.result) continue;
      if (group.exportMode === 'headings') pieces.push(`### ${t.title || `第 ${ti+1} 轮`}`);
      pieces.push(t.result.markdown.trim());
    }
  }
  return pieces.length ? pieces.join('\n\n') + '\n' : '';
}
export function duplicateGroup(source) {
  const group = structuredClone(source);
  group.id = uid(); group.name += '（副本）'; group.run = null; group.revision = 0;
  group.createdAt = group.updatedAt = now();
  for (const c of group.conversations) { c.id = uid(); for (const t of c.turns) { t.id = uid(); t.result = null; } }
  return group;
}
