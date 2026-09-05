import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';

for (const relativeManifest of ['manifest.json','extension/manifest.json']) {
  test(`${relativeManifest} references files that exist`,()=>{
    const manifestPath=resolve(relativeManifest);
    const base=resolve(relativeManifest,'..');
    const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
    const files=[manifest.background.service_worker,...Object.values(manifest.icons),
      ...Object.values(manifest.action.default_icon),...manifest.content_scripts.flatMap(c=>c.js)];
    for(const file of new Set(files))assert.ok(existsSync(resolve(base,file)),`${relativeManifest}: ${file}`);
    assert.deepEqual(manifest.host_permissions,['https://aistudio.google.com/*']);
    assert.ok(manifest.permissions.includes('downloads'),`${relativeManifest}: Markdown save dialog permission`);
  });
}

test('manager exposes explicit conversations and only Markdown delivery',()=>{
  const html=readFileSync(resolve('extension/manager.html'),'utf8');
  const script=readFileSync(resolve('extension/manager.js'),'utf8');
  assert.match(html,/name="conversationCount"/);
  assert.match(html,/id="conversation-rounds"/);
  assert.doesNotMatch(html+script,/backup-picker|bookflow-backup|导出完整备份|导入备份/);
  assert.match(script,/anchor\.download=name/);
  assert.match(script,/chrome\.downloads\.showDefaultFolder\(\)/);
  assert.match(script,/程序如何判断本轮完成/);
  assert.match(script,/正文框只放原文/);
});

test('manager imports a complete Codex task package without a backup workflow',()=>{
  const html=readFileSync(resolve('extension/manager.html'),'utf8');
  const script=readFileSync(resolve('extension/manager.js'),'utf8');
  assert.match(html,/id="bookflow-package-picker"/);
  assert.match(script,/导入 Codex 任务包/);
  assert.match(script,/parseBookflowPackage/);
  assert.match(script,/data-package-drop-zone/);
  assert.match(script,/DragEvent|dragover/);
  assert.match(script,/for\(const saved of savedGroups\).*DELETE/);
  assert.ok(existsSync(resolve('docs/bookflow-package.schema.json')));
  assert.ok(existsSync(resolve('examples/拆书任务包示例.bookflow.json')));
});

test('execution page uses a configurable large foreground window, records URLs, and closes completed pages',()=>{
  const background=readFileSync(resolve('extension/background.js'),'utf8');
  const runner=readFileSync(resolve('extension/content/runner.js'),'utf8');
  const manager=readFileSync(resolve('extension/manager.js'),'utf8');
  assert.match(manager,/data-field="focus-interval"/);
  assert.match(background,/executionBounds/);
  assert.match(background,/focused:true/);
  assert.match(background,/closeOtherExecutionPages/);
  assert.match(background,/closeExecutionWindow/);
  assert.match(background,/OPEN_SESSION/);
  assert.match(background,/restorableSessionUrl/);
  assert.match(manager,/已记录的 AI Studio 对话页面/);
  assert.match(runner,/focusIntervalSeconds/);
});

test('failures notify the user and preserve the current round',()=>{
  const background=readFileSync(resolve('extension/background.js'),'utf8');
  const manager=readFileSync(resolve('extension/manager.js'),'utf8');
  assert.match(background,/拆书任务已暂停，需要检查/);
  assert.match(background,/没有跳过当前轮次/);
  assert.match(manager,/任务已暂停，不会跳过当前轮次/);
  assert.match(manager,/检查后继续/);
  assert.match(background,/canReplaceExecutionPage/);
  assert.match(background,/本轮尚未发送，已安全新建页面/);
  assert.match(background,/没有可安全接管的发送记录/);
});
