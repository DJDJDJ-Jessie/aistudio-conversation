import {newGroup,newConversation,newTurn,uid,counts,assembleMarkdown,filename} from './lib/model.js';
import * as db from './lib/db.js';
import {parseBookflowPackage} from './lib/bookflow-package.js';

const $=s=>document.querySelector(s);
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths={plus:'M8 2v12M2 8h12',play:'m5 2 9 6-9 6Z',pause:'M5 3v10M11 3v10',download:'M8 2v8m-3-3 3 3 3-3M2 11v3h12v-3',upload:'M8 11V2m-3 3 3-3 3 3M2 11v3h12v-3',copy:'M6 5V2h8v9h-3M2 5h8v9H2Z',trash:'M2 4h12M6 4V2h4v2M4 4l1 10h6l1-10M7 7v4M9 7v4',up:'m3 10 5-5 5 5',down:'m3 6 5 5 5-5',close:'m4 4 8 8M4 12l8-8',image:'M2 2h12v12H2ZM2 11l4-4 3 3 2-2 3 3M10 5h.01',settings:'M2 4h12M2 12h12M5 2v4M11 10v4',external:'M9 2h5v5M14 2 7 9M6 3H2v11h11v-4',refresh:'M13 6a5 5 0 1 0 0 5M13 2v4H9',check:'m3 8 3 3 7-7',file:'M3 1h6l4 4v10H3ZM9 1v4h4M6 8h4M6 11h4'};
const icon=name=>`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${paths[name]||paths.file}"/></svg>`;
const button=(action,title,ico,extra='',label='')=>`<button type="button" class="quiet icon-button ${extra}" data-action="${action}" title="${title}" aria-label="${title}">${icon(ico)}${label}</button>`;
const app=$('#app');
let groups=[],selectedId=null,selectedTurnId=null,selectedConversationId=null,view='editor',scope='group',inspectorView='settings',options=null,models=[];
let dirty=false,saveTimer=null,saving=Promise.resolve(),saveState='已保存到本地',toastTimer,uploadTarget=null;
let previewURLs=new Map(),discovery=false,discoveryTimer=null;
const group=()=>groups.find(g=>g.id===selectedId);
const locked=()=>!!group()?.run;
const editable=()=>!locked();
const conversation=id=>group()?.conversations.find(c=>c.id===(id||selectedConversationId));
const locateTurn=id=>{for(const c of group()?.conversations||[]){const t=c.turns.find(t=>t.id===id);if(t)return{c,t};}return null;};
const statusNames={running:'执行中',pausing:'即将暂停',paused:'已暂停',error:'需要检查',completed:'已完成'};
const canRebuildPage=g=>g?.run?.status==='error'&&g.run.current?.ti===0&&!g.run.current.checkpoint&&/执行页面已关闭|No tab with id/i.test(g.run.error||'');
const conversationLetter=index=>{let value=index+1,label='';while(value){value--;label=String.fromCharCode(65+value%26)+label;value=Math.floor(value/26);}return label;};
const screenPayload=()=>({left:screen.availLeft??0,top:screen.availTop??0,width:screen.availWidth,height:screen.availHeight});
function hasConversationUrl(value){try{return !new URL(value).pathname.replace(/\/+$/,'').endsWith('/app/prompts/new_chat');}catch{return false;}}
async function rpc(type,payload={}) {
  if(!chrome?.runtime?.sendMessage) throw new Error('请在浏览器扩展中打开拆书工坊。');
  const response=await chrome.runtime.sendMessage({type,...payload});
  if(!response?.ok) throw new Error(response?.error||'插件未响应，请刷新工坊页面。');
  return response.value;
}
function toast(text) {clearTimeout(toastTimer);$('#toast').textContent=text;$('#toast').classList.add('show');toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),6000);}
function showError(error){toast(error.message||String(error));}
function setSaveState(text) {saveState=text;document.querySelectorAll('.save-label').forEach(e=>{e.textContent=text;e.classList.toggle('failed',text.includes('失败'));});}
function markDirty(){if(!editable())return;dirty=true;setSaveState('正在保存…');clearTimeout(saveTimer);saveTimer=setTimeout(()=>flush().catch(showError),450);}
async function flush() {
  clearTimeout(saveTimer);
  saving=saving.catch(()=>{}).then(async()=>{
    if(!dirty || !group())return;
    const target=group(),snapshot=structuredClone(target);dirty=false;
    try{const saved=await rpc('SAVE',{group:snapshot});target.revision=saved.revision;target.updatedAt=saved.updatedAt;setSaveState(dirty?'正在保存…':'已保存到本地');}
    catch(error){dirty=true;setSaveState('保存失败，请重试');throw error;}
  });
  return saving;
}
function selectedContext(){
  const g=group();if(!g)return;
  if(!g.conversations.some(c=>c.id===selectedConversationId))selectedConversationId=g.conversations[0]?.id;
  if(selectedTurnId!==''&&!locateTurn(selectedTurnId))selectedTurnId=conversation()?.turns[0]?.id;
}
function renderSidebar(){
  return `<aside class="sidebar"><div class="brand"><div class="brand-mark" aria-hidden="true"></div><div><div class="brand-title">拆书工坊</div><div class="brand-sub">AI STUDIO · BOOKFLOW</div></div></div>
    <div class="group-create-actions"><button class="new-group" data-action="new-group">${icon('plus')}新建组</button><button class="import-package-button" data-action="import-package" data-package-drop-zone title="点击选择，或把 .bookflow.json 文件拖到这里">${icon('upload')}<span>导入任务包</span><small>点击或拖入</small></button></div>
    <div class="sidebar-label"><span>我的拆书组</span><span class="mono">${String(groups.length).padStart(2,'0')}</span></div>
    <nav class="group-list" aria-label="拆书组">${groups.length?groups.map((g,i)=>{const n=counts(g);return `<button class="group-link ${g.id===selectedId?'selected':''}" data-action="select-group" data-id="${g.id}" ${g.id===selectedId?'aria-current="page"':''}><span class="book-index">${String(i+1).padStart(2,'0')}</span><span class="group-link-text"><strong>${escape(g.name||'未命名组')}</strong><small>${n.conversations} 个对话 · ${n.complete}/${n.total} 轮${g.run?` · ${statusNames[g.run.status]}`:''}</small></span></button>`;}).join(''):'<p class="list-empty">为这次要拆的书创建一个组。</p>'}</nav>
    <div class="sidebar-footer"><div><i class="local-dot"></i>计划与回复仅保存在此浏览器</div><small>完成后下载“组名.md”到浏览器下载目录。</small></div></aside>`;
}
function flowHTML(g) {
  return `<div class="flow" aria-label="按对话顺序执行">${g.conversations.map((c,ci)=>`${ci?'<span class="flow-arrow" aria-hidden="true">›</span>':''}<div class="flow-chapter"><div class="flow-label"><span>对话 ${conversationLetter(ci)}</span><span>${c.turns.length} 轮</span></div><div class="flow-marks">${c.turns.map((t,ti)=>`<span class="flow-mark ${t.result?'done':g.run?.current?.ci===ci&&g.run?.current?.ti===ti?'active':''}" title="${escape(t.title)} · ${t.result?'已完成':'待完成'}"></span>`).join('')}</div></div>`).join('')}</div>`;
}
function turnHTML(c,t,ci,ti) {
  const open=t.id===selectedTurnId,n=t.text.length,current=group().run?.current;
  return `<section class="turn ${t.result?'has-result':''} ${current?.ci===ci&&current?.ti===ti?'current':''}" data-cid="${c.id}" data-tid="${t.id}"><i class="turn-dot" aria-hidden="true"></i>
    <div class="turn-header"><button class="turn-toggle" data-action="toggle-turn" aria-expanded="${open}"><span class="turn-label">${String(ti+1).padStart(2,'0')}</span><span class="turn-name">${escape(t.title||`第 ${ti+1} 轮`)}</span></button><span class="turn-info">${t.result?'已保存回复':`${n.toLocaleString()} 字${t.attachments.length?` · ${t.attachments.length} 张图片`:''}`}</span>${button('toggle-turn',open?'收起轮次':'展开轮次',open?'up':'down')}</div>
    ${open?`<div class="turn-body"><input class="turn-title-field" data-field="turn-title" aria-label="轮次名称" value="${escape(t.title)}" placeholder="本轮名称，例如：第 1 章" ${locked()?'disabled':''}>
      <textarea class="prompt-editor" data-field="turn-text" aria-label="本轮文字内容" placeholder="这里只放本轮章节原文。&#10;&#10;拆书要求和输出格式请填写在右侧 System instructions；目录截图在下方添加。&#10;本轮会在上一轮回复完整保存后自动发送。" ${locked()?'disabled':''}>${escape(t.text)}</textarea>
      <div class="editor-meta"><span>正文框只放原文 · 图片会在同一轮发送</span><span data-char-count>${n.toLocaleString()} 字</span></div>
      ${editable()?`<div class="upload-zone" data-drop-zone><div><p>章节截图 / 大框架图片</p><small>拖入或粘贴图片 · 单张不超过 20 MB</small></div><button class="small" data-action="add-images">${icon('image')}添加图片</button></div>`:''}
      <div class="attachments">${t.attachments.map(a=>`<div class="attachment"><img data-asset="${a.id}" alt="${escape(a.name)}"><span title="${escape(a.name)}">${escape(a.name)}</span>${editable()?`<button data-action="remove-image" data-asset-id="${a.id}" aria-label="移除 ${escape(a.name)}">${icon('close')}</button>`:''}</div>`).join('')}</div>
      ${editable()?`<div class="turn-footer"><span class="hint">支持 PNG、JPG、WebP、GIF</span><div class="turn-order"><button class="quiet small" data-action="move-turn-up" ${ti===0?'disabled':''} aria-label="本轮上移">${icon('up')}</button><button class="quiet small" data-action="move-turn-down" ${ti===c.turns.length-1?'disabled':''} aria-label="本轮下移">${icon('down')}</button>${button('remove-turn','删除本轮','trash')}</div></div>`:''}
      ${t.result?`<details class="turn-result"><summary>本轮正式回复 · 已保存到本地</summary><pre>${escape(t.result.markdown)}</pre></details>`:''}</div>`:''}</section>`;
}
function conversationsHTML(g) {
  return `<div class="editor-toolbar"><div><strong>${g.conversations.length} 个独立对话，按 ${g.conversations.map((_,i)=>conversationLetter(i)).join(' → ')} 顺序执行</strong><p>同一对话中的轮次延续上下文；进入下一个对话时会新开 AI Studio 页面。</p></div><div class="editor-actions"><button class="small" data-action="import-chapters" ${locked()?'disabled':''}>${icon('upload')}导入章节</button><button class="small primary" data-action="add-conversation" ${locked()?'disabled':''}>${icon('plus')}新增对话</button></div></div>
    ${g.conversations.map((c,ci)=>`<article class="conversation" data-cid="${c.id}"><header class="conversation-head"><span class="conv-number">${conversationLetter(ci)}</span><div class="conv-heading"><div class="conv-kicker">第 ${ci+1} 个对话 · ${c.turns.length} 轮</div><input class="conv-title" data-field="conversation-title" aria-label="对话名称" value="${escape(c.title)}" ${locked()?'disabled':''}><div class="conv-note">${ci===0?'从新的上下文开始':'上一对话完成后自动新开'} · ${c.model||c.system?'使用独立设置':'沿用组设置'}</div></div><div class="conv-controls">${button('conversation-settings','设置本对话','settings')}${editable()?`${button('move-conversation-up','对话上移','up','reorder-conv')}${button('move-conversation-down','对话下移','down','reorder-conv')}${button('remove-conversation','删除对话','trash')}`:''}</div></header>
      ${c.turns.map((t,ti)=>turnHTML(c,t,ci,ti)).join('')}<div class="add-turn">${editable()?`<button class="quiet" data-action="add-turn">${icon('plus')}添加轮次</button>`:''}</div></article>`).join('')}
      ${editable()?`<button class="add-conversation" data-action="add-conversation">${icon('plus')}添加独立对话</button>`:''}`;
}
function markdownHTML(g) {
  const markdown=assembleMarkdown(g),n=counts(g);
  return `<div class="markdown-toolbar"><label class="muted">${n.complete}/${n.total} 轮已汇总</label><select data-field="export-mode" aria-label="Markdown 导出格式"><option value="plain" ${g.exportMode==='plain'?'selected':''}>只拼接回复（推荐）</option><option value="headings" ${g.exportMode==='headings'?'selected':''}>添加对话与轮次标题</option></select><button class="small" data-action="download" ${!markdown?'disabled':''}>${icon('download')}下载 Markdown</button></div>
    ${markdown?`<pre class="markdown-sheet">${escape(markdown)}</pre>`:`<div class="empty-result"><div><h3>让内容自己汇成一本书。</h3><p>每轮正式回复结束后，会按你编排的顺序出现在这里。执行途中也可以下载已完成的部分。</p></div></div>`}`;
}
function mainHTML() {
  const g=group();
  if(!g)return `<main class="workspace"><div class="topbar"><span>工作台</span><span>文字 + 图片 → Markdown</span></div><div class="empty-app"><div class="empty-content"><span class="eyebrow">给阅读留时间，把等待交给工坊</span><h1>把一整本书，<br>安排好再出发。</h1><p>先放好每个章节的内容，再安排哪些章节放在同一个对话。工坊依次发送、等待回复、保存结果，最后为你汇成一份 Markdown。</p><div class="sample-flow">一个组：《周期》<br>对话 01　▮ ▮ ▮　3 轮<br>对话 02　▮ ▮ ▮　3 轮<br>对话 03　▮ ▮ ▮ ▮　4 轮<br>↓<br>周期.md</div><div class="empty-actions"><button class="primary" data-action="new-group">${icon('plus')}创建第一个拆书组</button><button class="empty-package-import" data-action="import-package" data-package-drop-zone title="点击选择，或把 .bookflow.json 文件拖到这里">${icon('upload')}<span>导入 Codex 任务包</span><small>也可把文件拖到这里</small></button></div></div></div></main>`;
  const n=counts(g),run=g.run;
  return `<main class="workspace"><div class="topbar"><div class="crumb"><span>工作台</span><span>/</span><span>拆书编排</span></div><span class="save-label">${escape(saveState)}</span></div><div class="main-inner">
    <div class="group-heading"><div style="min-width:0;flex:1"><span class="eyebrow">BOOKFLOW / 拆书计划</span><input class="title-input" data-field="group-name" aria-label="组名称" value="${escape(g.name)}" maxlength="120" ${locked()?'disabled':''}><p class="subline">${n.conversations} 个独立对话 <span aria-hidden="true"> · </span> ${n.total} 轮内容 <span aria-hidden="true"> · </span> 最终文件：<span data-filename>${escape(filename(g.name))}</span></p></div><div class="group-actions">${button('duplicate','复制为新组','copy')}${button('delete-group','删除此组','trash')}</div></div>
    ${flowHTML(g)}
    ${run?.status==='error'?`<div class="error-box" role="alert"><strong>任务已暂停，不会跳过当前轮次。</strong><span>${escape(run.error)}</span><small>${canRebuildPage(g)?'当前对话的第 1 轮尚未发送。直接点击“检查后继续”，程序会自动新建执行页面。':'打开右侧“执行页面”检查后，点击“检查后继续”。已完成的回复不会丢失。'}</small></div>`:''}
    ${run?.status==='completed'?`<div class="success-box"><strong>全部正式回复已按顺序汇总。</strong><span>点击“汇总文档”或右侧按钮下载 ${escape(filename(g.name))}；下载后可直接打开浏览器下载目录。</span></div>`:''}
    ${locked()&&!['error','completed'].includes(run.status)?'<p class="hint" style="margin-bottom:15px">执行计划已锁定，避免改变发送顺序。需要修改内容时，可复制为新组。</p>':''}
    <div class="tabs"><button class="tab ${view==='editor'?'selected':''}" data-action="view-editor">编排内容 <span class="count-badge">${n.total}</span></button><button class="tab ${view==='markdown'?'selected':''}" data-action="view-markdown">汇总文档 <span class="count-badge">${n.complete}</span></button><span class="tabs-tail">串行执行 · 按轮保存</span></div>
    ${view==='editor'?conversationsHTML(g):markdownHTML(g)}</div></main>`;
}
function settingsHTML(g) {
  const c=conversation(),isConversation=scope==='conversation'&&c,config=isConversation?c:g;
  const system=config.system,disabled=locked()?'disabled':'';
  return `<div class="settings-column">${isConversation?`<div class="setting-context">${escape(c.title)} · 独立设置优先于组设置</div>`:''}
    <section class="settings-block"><div class="field-row"><h3>模型</h3><button class="quiet" data-action="discover" ${discovery||activeRun()?'disabled':''}>${icon('refresh')}${discovery?'正在读取…':'读取网页选项'}</button></div>
      <input data-field="model" list="model-options" aria-label="Model selection" placeholder="${isConversation?'留空则沿用组模型':'选择或输入模型 ID'}" value="${escape(config.model)}" ${disabled}>
      <datalist id="model-options">${models.map(m=>`<option value="${escape(m.id)}">${escape(m.name)}</option>`).join('')}</datalist>
      <p class="field-caption">Model selection${isConversation?' · 留空沿用组设置':''}</p>
      ${options?.error?`<p class="hint">${escape(options.error)} <button class="quiet small" data-action="open-probe">打开检测页</button></p>`:options?.at?`<p class="detected">已从网页读取 ${options.models.length} 个模型与 ${options.presets.length} 个指令预设</p>`:'<p class="hint">初始列表来自你的 DOM 包，可从当前网页更新。</p>'}</section>
    <section class="settings-block"><label>系统指令<select data-field="system-mode" ${disabled}>
      ${isConversation?`<option value="inherit" ${!system?'selected':''}>沿用组设置</option>`:''}
      <option value="custom" ${system?.mode==='custom'?'selected':''}>自定义指令</option><option value="preset" ${system?.mode==='preset'?'selected':''}>网页已有预设</option><option value="none" ${system?.mode==='none'?'selected':''}>不使用系统指令</option></select></label>
      ${system?.mode==='custom'?`<textarea data-field="system-text" aria-label="System instructions" placeholder="填写整本书共用的拆解要求、输出格式等。每个新对话会重新设置。" ${disabled}>${escape(system.text)}</textarea><p class="field-caption">System instructions · 空白表示无指令</p>`:''}
      ${system?.mode==='preset'?`<input data-field="system-preset" list="preset-options" aria-label="系统指令预设名称" placeholder="例如：经济类拆书" value="${escape(system.preset)}" ${disabled}><datalist id="preset-options">${(options?.presets||[]).map(p=>`<option value="${escape(p)}"></option>`).join('')}</datalist><p class="field-caption">名称必须与此浏览器 AI Studio 中的预设一致。</p>`:''}
      ${!system?'<p class="hint">这个对话使用组的模型指令。可以在这里单独覆盖。</p>':''}</section>
    ${!isConversation?`<div class="tool-policy"><strong>辅助工具默认关闭</strong><span>每轮发送前自动确认关闭 Code execution、Grounding with Google Search 和 URL context。</span></div><label>AI Studio 置顶间隔<input type="number" data-field="focus-interval" min="2" max="120" value="${g.focusIntervalSeconds??10}" ${disabled}><span class="field-caption">秒 · 默认 10 秒。执行页会以较大的桌面右侧窗口运行，并定期切到最前面；切换时会转移键盘焦点</span></label><label>异常等待上限<input type="number" data-field="timeout" min="1" max="120" value="${g.timeoutMinutes}" ${disabled}><span class="field-caption">分钟 · 程序会自动判断回复是否完成；这里只在网页异常卡住时暂停</span></label>`:''}
    </div>`;
}
function activeRun(){return groups.some(g=>['running','pausing'].includes(g.run?.status));}
function sessionPagesHTML(g){
  const run=g.run,rows=g.conversations.map((c,ci)=>({c,ci,session:run?.sessions?.[c.id]})).filter(item=>item.session);
  if(!rows.length)return '';
  return `<details class="runtime-card session-pages" open><summary>已记录的 AI Studio 对话页面 <span>${rows.length}</span></summary><div class="session-page-list">${rows.map(({c,ci,session})=>`<div class="session-page-row" data-cid="${escape(c.id)}"><span><b>对话 ${conversationLetter(ci)} · ${escape(c.title)}</b><small>${hasConversationUrl(session.url)?'独立会话地址已保存，可在页面关闭后重新打开':'页面已记录；等待 AI Studio 生成独立会话地址'}</small></span><button class="quiet small" data-action="open-session">${icon('external')}打开</button></div>`).join('')}</div><p class="session-page-note">这些地址随任务保存在浏览器本地。页面关闭后仍可重新打开；已采集的 Markdown 回复不受影响。</p></details>`;
}
function runtimeHTML(g){
  const n=counts(g),run=g.run,status=run?.status,current=run?.current;
  const hasSessions=!!Object.keys(run?.sessions||{}).length;
  const position=current?`正在处理：对话 ${conversationLetter(current.ci)} · 第 ${current.ti+1} 轮`:status==='completed'?'全部轮次已完成':status==='paused'?'任务已暂停':status==='error'?'当前轮次需要检查':'等待开始';
  return `<div class="runtime-column">
    <section class="runtime-card progress-card"><div class="runtime-card-heading"><div><span class="runtime-kicker">实时状态</span><h3>执行进度</h3></div><span class="status-pill ${status||''}">${status==='running'?'<i class="busy-dot"></i>':''}${statusNames[status]||'待开始'}</span></div>
      <div class="live-position">${status==='running'?'<i class="busy-dot"></i>':''}<strong>${escape(position)}</strong></div>
      <div class="progress-row"><span>${n.complete?'已自动保存正式回复':'尚未保存回复'}</span><span class="mono">${n.complete} / ${n.total}</span></div><div class="progress-track"><div class="progress-fill" style="width:${n.total?n.complete/n.total*100:0}%"></div></div>
      <p class="run-message">${escape(run?.message||'准备好所有章节后，一次开始。每个轮次完成后会自动保存并继续。')}</p>
    </section>
    <section class="runtime-card action-card"><div class="runtime-card-heading"><div><span class="runtime-kicker">任务操作</span><h3>${run?'控制当前任务':'开始执行'}</h3></div></div>
      ${!run?`<button class="primary run-button" data-action="start">${icon('play')}开始串行执行</button>`:status==='running'?`<button class="run-button" data-action="pause">${icon('pause')}本轮完成后暂停</button>`:status==='pausing'?'<button class="run-button" disabled>保存本轮后暂停…</button>':['paused','error'].includes(status)?`<button class="primary run-button" data-action="resume">${icon('play')}${status==='error'?'检查后继续':'继续执行'}</button>`:`<button class="primary run-button" data-action="download">${icon('download')}下载完整 Markdown</button>`}
      <div class="secondary-run">${run&&hasSessions?`<button data-action="open-run">${icon('external')}${status==='completed'?'重新打开最后页面':'执行页面'}</button>`:run?'<button disabled>执行页将在开始时建立</button>':''}<button data-action="download" ${!n.complete?'disabled':''}>${icon('download')}下载${status==='completed'?'结果':'已完成部分'}</button></div>
      <div class="note-box">${run?.current?.checkpoint?'已记录本轮发送意图。执行页被关闭时，会尝试按保存的会话地址重新接管；恢复后只采集已有回复，不自动重发。':status==='completed'?'任务完成后已自动关闭 AI Studio 执行窗口；每个对话的会话地址仍保留在下方。':'AI Studio 会以较大的桌面右侧窗口运行，并按设置间隔切到最前面。新对话开始后会关闭上一个对话页面；其会话地址会继续保留。'}</div>
    </section>
    <section class="runtime-card storage-card"><div class="runtime-card-heading"><div><span class="runtime-kicker">保存与导出</span><h3>${escape(filename(g.name))}</h3></div></div>
      <div class="storage-row"><span><b>每轮回复</b><small>生成完成后立即自动保存到浏览器本地</small></span><strong>${n.complete} 份</strong></div>
      <div class="storage-row"><span><b>最终文档</b><small>所有回复按对话和轮次顺序汇总</small></span><strong>手动下载</strong></div>
      ${status==='completed'?`<button class="folder-button" data-action="show-downloads">${icon('external')}打开浏览器下载目录</button>`:''}
    </section>
    ${sessionPagesHTML(g)}
    <details class="runtime-card logic-card"><summary>程序如何判断本轮完成</summary><div class="completion-logic"><span>${icon('check')}发现本轮对应的新 Gemini 回复</span><span>${icon('check')}正式回复操作区已经出现，Run 按钮恢复可用</span><span>${icon('check')}正文连续稳定后保存，并排除思考过程</span></div></details>
    ${run?.logs?.length?`<details class="runtime-card logs"><summary>查看执行记录</summary>${run.logs.slice(-12).reverse().map(l=>`<div class="log-line"><span class="log-time">${new Date(l.at).toLocaleTimeString('zh-CN',{hour12:false})}</span>${escape(l.message)}</div>`).join('')}</details>`:''}
  </div>`;
}
function inspectorHTML(){
  const g=group();
  if(!g)return `<aside class="inspector"><div class="inspector-heading"><h2>任务控制台</h2></div><div class="empty-inspector"><p>创建组后，可分别查看执行设置和运行进度。</p></div></aside>`;
  const status=g.run?.status;
  return `<aside class="inspector"><div class="inspector-heading"><h2>任务控制台</h2><span class="status-pill ${status||''}">${status==='running'?'<i class="busy-dot"></i>':''}${statusNames[status]||'待编排'}</span></div>
    <div class="inspector-mode-tabs" role="tablist" aria-label="任务控制台"><button class="${inspectorView==='settings'?'selected':''}" data-action="inspector-settings" role="tab" aria-selected="${inspectorView==='settings'}">${icon('settings')}执行设置</button><button class="${inspectorView==='run'?'selected':''}" data-action="inspector-run" role="tab" aria-selected="${inspectorView==='run'}">${icon('play')}运行与结果</button></div>
    <div class="inspector-body ${inspectorView==='run'?'runtime-view':'settings-view'}">${inspectorView==='settings'?`<div class="scope-tabs"><button class="${scope==='group'?'selected':''}" data-action="scope-group">组设置</button><button class="${scope==='conversation'?'selected':''}" data-action="scope-conversation">当前对话</button></div>${settingsHTML(g)}<section class="settings-launch"><p>${g.run?'任务已经建立，配置已锁定。可前往运行页查看实时状态、保存结果和下载文档。':'设置会自动保存。确认模型和系统指令后即可开始，启动后会自动转到运行页。'}</p>${g.run?`<button class="primary" data-action="inspector-run">${icon('play')}查看运行与结果</button>`:`<button class="primary" data-action="start">${icon('play')}开始串行执行</button>`}</section>`:runtimeHTML(g)}</div></aside>`;
}
function render(){selectedContext();app.innerHTML=`<div class="layout">${renderSidebar()}${mainHTML()}${inspectorHTML()}</div>`;void loadImages();}
async function loadImages(){
  for(const image of document.querySelectorAll('img[data-asset]')){
    const id=image.dataset.asset;
    if(previewURLs.has(id)){image.src=previewURLs.get(id);continue;}
    const asset=await db.get('assets',id);if(asset){const url=URL.createObjectURL(asset.blob);previewURLs.set(id,url);if(image.isConnected)image.src=url;}
  }
}
async function refresh(){
  const fresh=await rpc('LIST');
  // Unexecuted drafts may have keystrokes not yet committed by the debounce.
  if(group()&&!group().run&&(dirty||document.activeElement?.matches('input,textarea,select'))) {
    groups= fresh.map(g=>g.id===selectedId?group():g);return;
  }
  const before=group(),oldKey=before?JSON.stringify([before.run?.status,before.run?.message,counts(before).complete,before.run?.current?.token]):'';
  const oldStatus=before?.run?.status;
  groups=fresh;
  const after=group(),newStatus=after?.run?.status,newKey=after?JSON.stringify([newStatus,after.run?.message,counts(after).complete,after.run?.current?.token]):'';
  if(oldStatus!==newStatus&&newStatus)inspectorView='run';
  if(oldKey!==newKey)render();
}
async function confirmDeletion(title,text){
  $('#confirm-title').textContent=title;$('#confirm-text').textContent=text;
  const dialog=$('#confirm-dialog');dialog.returnValue='cancel';dialog.showModal();
  return new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true}));
}
async function saveDownload(content,name,type){
  const blob=content instanceof Blob?content:new Blob([content],{type});
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');
  anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
async function addImages(files,tid){
  if(!editable())return;
  const found=locateTurn(tid);if(!found)return;
  let bytes=found.t.attachments.reduce((sum,a)=>sum+a.size,0),added=0;
  for(const file of files){
    if(!/^image\/(png|jpeg|webp|gif)$/.test(file.type))throw new Error(`“${file.name}”不是支持的图片，请使用 PNG、JPG、WebP 或 GIF。`);
    if(file.size>20*1024*1024)throw new Error(`“${file.name}”超过 20 MB，请缩小图片后添加。`);
    if(bytes+file.size>60*1024*1024)throw new Error('每轮图片总计最多 60 MB，请分到其他轮次。');
    bytes+=file.size;
  }
  for(const file of files){
    const a={id:uid(),name:file.name||`截图-${Date.now()}.png`,type:file.type,size:file.size};
    await db.put('assets',{...a,blob:file});found.t.attachments.push(a);added++;
  }
  if(added){markDirty();render();await flush();toast(`已添加 ${added} 张图片，并保存到本地。`);}
}
async function importBookflowFile(file){
  if(!file)return;
  if(file.size>200*1024*1024)throw new Error('任务包最多 200 MB；大图片请压缩后再生成任务包。');
  let payload;
  try{payload=JSON.parse(await file.text());}catch(error){throw new Error(`无法读取任务包 JSON：${error.message}`);}
  const imported=parseBookflowPackage(payload),savedGroups=[],assetIds=[];
  try{
    for(const asset of imported.assets){await db.put('assets',asset);assetIds.push(asset.id);}
    for(const item of imported.groups)savedGroups.push(await rpc('SAVE',{group:item}));
  }catch(error){
    for(const saved of savedGroups)await rpc('DELETE',{groupId:saved.id}).catch(()=>{});
    for(const id of assetIds)await db.remove('assets',id).catch(()=>{});
    throw error;
  }
  groups=await rpc('LIST');selectedId=savedGroups[0].id;selectedConversationId=savedGroups[0].conversations[0]?.id||null;
  selectedTurnId=savedGroups[0].conversations[0]?.turns[0]?.id||null;view='editor';scope='group';inspectorView='settings';dirty=false;
  render();toast(`已从“${file.name}”导入 ${savedGroups.length} 个组、${savedGroups.reduce((sum,g)=>sum+counts(g).total,0)} 个轮次${imported.assets.length?`和 ${imported.assets.length} 张图片`:''}。`);
}
function updateField(element){
  const field=element.dataset.field;if(!field)return;
  const g=group(),container=element.closest('[data-tid]'),cnode=element.closest('[data-cid]');
  if(field==='export-mode') {g.exportMode=element.value;if(editable())markDirty();else void rpc('EXPORT_MODE',{groupId:g.id,mode:g.exportMode}).catch(showError);render();return;}
  if(!editable())return;
  const context=scope==='conversation'?conversation():g;
  switch(field){
    case 'group-name':g.name=element.value;document.querySelectorAll('[data-filename]').forEach(e=>e.textContent=filename(g.name));break;
    case 'conversation-title':conversation(cnode.dataset.cid).title=element.value;break;
    case 'turn-title':locateTurn(container.dataset.tid).t.title=element.value;break;
    case 'turn-text':locateTurn(container.dataset.tid).t.text=element.value;container.querySelector('[data-char-count]').textContent=`${element.value.length.toLocaleString()} 字`;break;
    case 'model':context.model=element.value.trim();break;
    case 'system-mode':context.system=element.value==='inherit'?null:{mode:element.value,text:context.system?.text||'',preset:context.system?.preset||''};markDirty();render();return;
    case 'system-text':context.system.text=element.value;break;
    case 'system-preset':context.system.preset=element.value;break;
    case 'focus-interval':g.focusIntervalSeconds=Number(element.value);break;
    case 'timeout':g.timeoutMinutes=Number(element.value);break;
  }
  markDirty();
}
app.addEventListener('input',event=>{if(event.target.matches('input[data-field],textarea[data-field]'))updateField(event.target);});
app.addEventListener('change',event=>{if(event.target.matches('select[data-field]'))updateField(event.target);});

const mutatingActions=new Set(['add-turn','remove-turn','move-turn-up','move-turn-down','add-conversation','remove-conversation','move-conversation-up','move-conversation-down','add-images','remove-image','import-chapters']);
app.addEventListener('click',event=>{
  const el=event.target.closest('[data-action]');if(!el||el.disabled)return;
  void act(el).catch(showError);
});
async function act(el){
  const action=el.dataset.action,g=group();
  if(mutatingActions.has(action)&&locked())return;
  const cnode=el.closest('[data-cid]'),tnode=el.closest('[data-tid]');
  const c=conversation(cnode?.dataset.cid),found=tnode?locateTurn(tnode.dataset.tid):null;
  switch(action){
    case 'new-group':await flush();$('#create-form').reset();$('#create-form [name=conversationCount]').value='3';renderConversationRoundInputs(3,[3,3,4]);$('#create-dialog').showModal();return;
    case 'import-package':await flush();$('#bookflow-package-picker').click();return;
    case 'select-group':await flush();selectedId=el.dataset.id;selectedTurnId=null;selectedConversationId=null;scope='group';view='editor';inspectorView=group()?.run?'run':'settings';render();return;
    case 'view-editor':view='editor';render();return;
    case 'view-markdown':await flush();view='markdown';render();return;
    case 'inspector-settings':inspectorView='settings';render();return;
    case 'inspector-run':inspectorView='run';render();return;
    case 'scope-group':scope='group';inspectorView='settings';render();return;
    case 'scope-conversation':scope='conversation';inspectorView='settings';render();return;
    case 'conversation-settings':selectedConversationId=c.id;scope='conversation';inspectorView='settings';render();return;
    case 'toggle-turn':selectedTurnId=selectedTurnId===found.t.id?'':found.t.id;selectedConversationId=c.id;render();return;
    case 'add-turn':{const t=newTurn(`第 ${c.turns.length+1} 轮`);c.turns.push(t);selectedTurnId=t.id;selectedConversationId=c.id;break;}
    case 'add-conversation':{const fresh=newConversation(g.conversations.length+1);fresh.title=`对话 ${conversationLetter(g.conversations.length)}`;g.conversations.push(fresh);selectedConversationId=fresh.id;selectedTurnId=fresh.turns[0].id;break;}
    case 'remove-turn':if(!await confirmDeletion('删除这一轮？','这一轮的文字、图片引用和编排会从本组移除。'))return;c.turns.splice(c.turns.indexOf(found.t),1);break;
    case 'remove-conversation':if(!await confirmDeletion('删除这个对话？',`“${c.title}”下面的 ${c.turns.length} 轮内容都会从本组移除。`))return;g.conversations.splice(g.conversations.indexOf(c),1);break;
    case 'move-turn-up':case 'move-turn-down':{const i=c.turns.indexOf(found.t),j=i+(action.endsWith('up')?-1:1);if(j>=0&&j<c.turns.length)[c.turns[i],c.turns[j]]=[c.turns[j],c.turns[i]];break;}
    case 'move-conversation-up':case 'move-conversation-down':{const i=g.conversations.indexOf(c),j=i+(action.endsWith('up')?-1:1);if(j>=0&&j<g.conversations.length)[g.conversations[i],g.conversations[j]]=[g.conversations[j],g.conversations[i]];break;}
    case 'add-images':uploadTarget=found.t.id;$('#image-picker').click();return;
    case 'remove-image':found.t.attachments=found.t.attachments.filter(a=>a.id!==el.dataset.assetId);break;
    case 'import-chapters':$('#chapter-picker').click();return;
    case 'duplicate':{await flush();const clone=await rpc('DUPLICATE',{groupId:g.id});groups.unshift(clone);selectedId=clone.id;selectedTurnId=null;render();toast('已复制内容和编排。新组从新的对话开始执行。');return;}
    case 'delete-group':{await flush();if(!await confirmDeletion('删除整个拆书组？',`“${g.name}”的计划和已保存回复会从浏览器移除，请先下载需要的结果。`))return;await rpc('DELETE',{groupId:g.id});groups=groups.filter(x=>x.id!==g.id);selectedId=groups[0]?.id;render();return;}
    case 'start':case 'pause':case 'resume':
      await flush();el.disabled=true;
      try{await rpc({start:'START',pause:'PAUSE',resume:'RESUME'}[action],{groupId:g.id,...(action!=='pause'?{screen:screenPayload()}:{})});groups=await rpc('LIST');inspectorView='run';render();}
      catch(error){el.disabled=false;throw error;}return;
    case 'open-run':await rpc('OPEN_RUN',{groupId:g.id,screen:screenPayload()});return;
    case 'open-session':await rpc('OPEN_SESSION',{groupId:g.id,conversationId:c.id,screen:screenPayload()});return;
    case 'download':{await flush();const md=assembleMarkdown(g);if(!md)throw new Error('还没有完成的回复。');await saveDownload(md,filename(g.name),'text/markdown;charset=utf-8');toast(counts(g).complete===counts(g).total?'Markdown 已下载到浏览器的默认下载目录。':'当前已完成的部分已下载到浏览器的默认下载目录。');return;}
    case 'show-downloads':chrome.downloads.showDefaultFolder();return;
    case 'discover':{
      await flush();discovery=true;render();
      try{await rpc('DISCOVER_OPTIONS');toast('正在独立的 AI Studio 检测页读取选项，不会发送对话。');
        clearTimeout(discoveryTimer);discoveryTimer=setTimeout(()=>{discovery=false;render();toast('读取尚未完成，请打开 AI Studio 检查登录状态后重试。');},60000);
      }catch(error){discovery=false;render();throw error;}return;
    }
    case 'open-probe':if(options?.tabId){await chrome.tabs.update(options.tabId,{active:true});}return;
  }
  markDirty();render();
}

function renderConversationRoundInputs(count,values=[]){
  const target=$('#conversation-rounds'),safe=Math.max(1,Math.min(30,Number(count)||1));
  target.innerHTML=Array.from({length:safe},(_,i)=>`<label><span><b>对话 ${conversationLetter(i)}</b><small>${i?'前一个对话结束后自动新开':'第一个独立对话'}</small></span><span class="round-input"><input name="rounds" type="number" min="1" max="100" value="${Number(values[i])||1}" required><em>轮</em></span></label>`).join('');
}
$('#create-form [name=conversationCount]').addEventListener('input',event=>{
  const existing=[...document.querySelectorAll('#conversation-rounds input[name=rounds]')].map(input=>input.value);
  renderConversationRoundInputs(event.target.value,existing);
});
renderConversationRoundInputs(3,[3,3,4]);
$('#create-form').addEventListener('submit',event=>{
  event.preventDefault();
  void (async()=>{
    const form=new FormData(event.target),name=String(form.get('name')).trim(),conversationCount=Number(form.get('conversationCount'));
    const numbers=form.getAll('rounds').map(Number);
    if(!Number.isInteger(conversationCount)||conversationCount<1||conversationCount>30||numbers.length!==conversationCount)throw new Error('对话数量需要在 1–30 之间。');
    if(numbers.some(n=>!Number.isInteger(n)||n<1||n>100)||numbers.reduce((a,b)=>a+b,0)>300)throw new Error('每个对话需要 1–100 轮，所有对话合计最多 300 轮。');
    const fresh=newGroup(name);let ordinal=0;
    fresh.conversations=numbers.map((n,i)=>{const c=newConversation(i+1);c.title=`对话 ${conversationLetter(i)}`;c.turns=Array.from({length:n},()=>newTurn(`第 ${++ordinal} 章`));return c;});
    const saved=await rpc('SAVE',{group:fresh});groups.unshift(saved);selectedId=saved.id;selectedTurnId=null;selectedConversationId=null;view='editor';scope='group';inspectorView='settings';dirty=false;
    $('#create-dialog').close();render();
  })().catch(showError);
});
document.querySelectorAll('[data-close-dialog]').forEach(el=>el.addEventListener('click',()=>el.closest('dialog').close()));
$('#image-picker').addEventListener('change',event=>{const files=[...event.target.files];event.target.value='';void addImages(files,uploadTarget).catch(showError);});
app.addEventListener('paste',event=>{
  if(!editable())return;
  const files=[...event.clipboardData.items].filter(i=>i.kind==='file'&&i.type.startsWith('image/')).map(i=>i.getAsFile()).filter(Boolean);
  const target=event.target.closest('[data-tid]');
  if(files.length&&target){event.preventDefault();void addImages(files,target.dataset.tid).catch(showError);}
});
app.addEventListener('dragover',event=>{const zone=event.target.closest('[data-package-drop-zone],[data-drop-zone]');if(zone){event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='copy';zone.classList.add('dragging');}});
app.addEventListener('dragleave',event=>{const zone=event.target.closest('[data-package-drop-zone],[data-drop-zone]');if(zone&&!zone.contains(event.relatedTarget))zone.classList.remove('dragging');});
app.addEventListener('drop',event=>{
  const packageZone=event.target.closest('[data-package-drop-zone]');
  if(packageZone){event.preventDefault();packageZone.classList.remove('dragging');const files=[...event.dataTransfer.files];void (async()=>{await flush();if(files.length!==1)throw new Error('一次请拖入一个任务包文件。');await importBookflowFile(files[0]);})().catch(showError);return;}
  const zone=event.target.closest('[data-drop-zone]');if(!zone)return;event.preventDefault();zone.classList.remove('dragging');
  void addImages([...event.dataTransfer.files],zone.closest('[data-tid]').dataset.tid).catch(showError);
});
window.addEventListener('dragend',()=>document.querySelectorAll('.dragging').forEach(element=>element.classList.remove('dragging')));
$('#chapter-picker').addEventListener('change',event=>{
  const files=[...event.target.files].sort((a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true}));event.target.value='';
  void (async()=>{
    if(!editable()||!files.length)return;
    if(files.some(f=>f.size>10*1024*1024))throw new Error('单个章节文件最多 10 MB，请先拆分较大的文件。');
    const g=group(),empty=g.conversations.flatMap(c=>c.turns.map(t=>({c,t}))).filter(({t})=>!t.text.trim()&&!t.attachments.length);
    // Fill the existing 3/3/4 slots in order before appending any new turns.
    for(const [i,file] of files.entries()){
      let target=empty[i];
      if(!target){let c=g.conversations.at(-1);if(!c){c=newConversation();g.conversations.push(c);}const t=newTurn();c.turns.push(t);target={c,t};}
      target.t.title=file.name.replace(/\.(md|markdown|txt)$/i,'');target.t.text=await file.text();
      if(i===0){selectedTurnId=target.t.id;selectedConversationId=target.c.id;}
    }
    markDirty();render();await flush();toast(`已按文件名顺序导入 ${files.length} 章，优先填入现有空轮次。`);
  })().catch(showError);
});
$('#bookflow-package-picker').addEventListener('change',event=>{
  const file=event.target.files[0];event.target.value='';void importBookflowFile(file).catch(showError);
});
chrome.runtime.onMessage.addListener(message=>{
  if(message.type==='CHANGED')void refresh().catch(showError);
  if(message.type==='OPTIONS_CHANGED')void (async()=>{options=await rpc('GET_OPTIONS');if(options?.models)models=options.models;discovery=false;clearTimeout(discoveryTimer);render();if(options?.error)toast(options.error);else toast('网页模型和系统指令预设已更新。');})().catch(showError);
});
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}for(const url of previewURLs.values())URL.revokeObjectURL(url);});
async function init(){
  const results=await Promise.all([rpc('LIST'),rpc('GET_OPTIONS'),fetch('models.json').then(r=>r.json())]);
  groups=results[0];options=results[1];models=options?.models||results[2].models;selectedId=groups[0]?.id||null;render();
}
void init().catch(error=>{app.textContent=`加载失败：${error.message}。请从浏览器扩展图标打开拆书工坊。`;});
