import * as db from './lib/db.js';
import { uid, now, validateGroup, nextPending, settingsFor, counts, duplicateGroup } from './lib/model.js';

const HOME='https://aistudio.google.com/app/prompts/new_chat';
const DEFAULT_FOCUS_INTERVAL_SECONDS=10;
// The same source supports loading either the whole project root or the standalone extension folder.
const EXTENSION_BASE=chrome.runtime.getManifest().background.service_worker.startsWith('extension/')?'extension/':'';
const resource=path=>EXTENSION_BASE+path;
const activeStatus=s=>s==='running'||s==='pausing';
let queue=Promise.resolve();
function serial(fn) { const result=queue.then(fn);queue=result.catch(()=>{});return result; }
async function persist(group) {
  group.updatedAt=now();group.revision=(group.revision||0)+1;
  await db.put('groups',group);
  chrome.runtime.sendMessage({type:'CHANGED',groupId:group.id}).catch(()=>{});
}
function log(group,message) {
  group.run.logs=[...(group.run.logs||[]),{at:now(),message}].slice(-100);
  group.run.message=message;
}
async function activeGroup() { return (await db.all('groups')).find(g=>activeStatus(g.run?.status)); }
async function updatePower() {
  if(await activeGroup()) chrome.power.requestKeepAwake('system'); else chrome.power.releaseKeepAwake();
}
async function fail(group,error) {
  group.run.status='error';group.run.error=error;log(group,error);
  await persist(group);await updatePower();
  await chrome.action.setBadgeText({text:'!'});
  chrome.action.setBadgeBackgroundColor({color:'#AE4B31'});
  await notifyFailure(group,error);
}
async function notifyFailure(group,error) {
  const reason=String(error||'未知异常').replace(/\s+/g,' ').trim();
  chrome.notifications.create(`bookflow-error-${group.id}`,{type:'basic',iconUrl:resource('icons/128.png'),
    title:'拆书任务已暂停，需要检查',
    message:`「${group.name}」没有跳过当前轮次。${reason.slice(0,180)}`,
    requireInteraction:true}).catch(()=>{});
}
async function notifyDone(group) {
  chrome.notifications.create(`bookflow-${group.id}`,{type:'basic',iconUrl:resource('icons/128.png'),title:'拆书完成，可以下载了',
    message:`「${group.name}」的 ${counts(group).complete} 轮回复已自动保存。请在工作台下载完整 Markdown。`}).catch(()=>{});
}
async function tabMessage(tabId,message) {
  try { return await chrome.tabs.sendMessage(tabId,message); } catch { return null; }
}
async function executionWindow(group) {
  const id=group.run?.executionWindowId;
  if(!id)return null;
  try{return await chrome.windows.get(id);}catch{return null;}
}
function executionBounds(anchor={},screen={}) {
  const areaWidth=Math.max(640,Number(screen.width)||Number(anchor.width)||1366),areaHeight=Math.max(600,Number(screen.height)||Number(anchor.height)||768);
  const areaLeft=Number.isFinite(Number(screen.left))?Number(screen.left):(Number(anchor.left)||0);
  const areaTop=Number.isFinite(Number(screen.top))?Number(screen.top):(Number(anchor.top)||0);
  // AI Studio hides Run settings controls at its narrow responsive breakpoint.
  // Keep a substantial working width while leaving part of the desktop visible.
  const width=Math.min(areaWidth-20,Math.max(1050,Math.min(1400,Math.round(areaWidth*.68))));
  const height=Math.min(areaHeight-20,Math.max(680,Math.min(1000,areaHeight-20)));
  return {left:Math.round(areaLeft+areaWidth-width-10),top:Math.round(areaTop+10),width:Math.round(width),height:Math.round(height)};
}
async function refreshExecutionBounds(group,sender,screen) {
  if(!group?.run)return false;
  let anchor;try{anchor=await chrome.windows.get(sender.tab.windowId);}catch{anchor=await chrome.windows.getLastFocused().catch(()=>null);}
  if(screen || group.run.layoutVersion!==2 || Number(group.run.executionBounds?.width)<900) {
    const bounds=executionBounds(anchor,screen||{});
    group.run.executionBounds=bounds;group.run.requestedExecutionBounds={...bounds};group.run.layoutVersion=2;
    return true;
  }
  return false;
}
async function layoutExecutionWindow(group,window,{focus=false}={}) {
  if(window.state!=='normal')window=await chrome.windows.update(window.id,{state:'normal'});
  const bounds=group.run?.executionBounds;
  const changes={...(bounds||{}),...(focus?{focused:true}:{})};
  if(!Object.keys(changes).length)return window;
  try{return await chrome.windows.update(window.id,changes);}
  catch(error){
    if(!/bounds|visible screen space/i.test(error.message)||!bounds)throw error;
    group.run.executionBounds=null;
    return focus?chrome.windows.update(window.id,{focused:true}):window;
  }
}
async function createExecutionWindow(group,options) {
  const bounds=group.run?.executionBounds;
  try{return await chrome.windows.create({...options,...(bounds||{})});}
  catch(error){
    if(!/bounds|visible screen space/i.test(error.message)||!bounds)throw error;
    const window=await chrome.windows.create(options);
    const actual={left:window.left,top:window.top,width:window.width,height:window.height};
    group.run.executionBounds=executionBounds(window,actual);
    return layoutExecutionWindow(group,window,{focus:!!options.focused});
  }
}
async function keepExecutionPageVisible(group,tabId,{focus=false}={}) {
  let tab=await chrome.tabs.get(tabId),window=await executionWindow(group),changed=false;
  if(!window) {
    window=await createExecutionWindow(group,{tabId,type:'normal',focused:focus});
    group.run.executionWindowId=window.id;changed=true;
    tab=await chrome.tabs.get(tabId);
  } else if(tab.windowId!==window.id) {
    await chrome.tabs.move(tabId,{windowId:window.id,index:-1});
    tab=await chrome.tabs.get(tabId);changed=true;
  }
  if(!tab.active || tab.autoDiscardable!==false) {
    tab=await chrome.tabs.update(tabId,{active:true,autoDiscardable:false});
  }
  await layoutExecutionWindow(group,window,{focus});
  return {tab,changed};
}
async function createExecutionPage(group,url=HOME) {
  let window=await executionWindow(group),tab;
  if(window) {
    window=await layoutExecutionWindow(group,window,{focus:true});
    tab=await chrome.tabs.create({windowId:window.id,url,active:true});
  } else {
    window=await createExecutionWindow(group,{url,type:'normal',focused:true});
    tab=window.tabs?.[0]||(await chrome.tabs.query({windowId:window.id}))[0]||null;
    if(!tab)throw new Error('无法创建 AI Studio 执行窗口。');
    group.run.executionWindowId=window.id;
  }
  return await chrome.tabs.update(tab.id,{active:true,autoDiscardable:false});
}
async function closeOtherExecutionPages(group,keepTabId) {
  const ids=[...new Set(Object.values(group.run?.sessions||{}).map(session=>session.tabId).filter(id=>id&&id!==keepTabId))];
  for(const id of ids)try{await chrome.tabs.remove(id);}catch{}
}
async function closeExecutionWindow(group) {
  const window=await executionWindow(group);
  if(window)try{await chrome.windows.remove(window.id);}catch{}
  if(group.run){group.run.executionWindowId=null;group.run.executionWindowClosedAt=now();}
}
function canReplaceExecutionPage(current,ti=current?.ti) {
  return ti===0 && !current?.checkpoint;
}
function restorableSessionUrl(session) {
  try {
    const url=new URL(session?.url),home=new URL(HOME);
    if(url.origin!==home.origin)return null;
    if(url.pathname.replace(/\/+$/,'')===home.pathname.replace(/\/+$/,''))return null;
    return url.href;
  } catch{return null;}
}
function currentConversationId(group) {
  const current=group?.run?.current;
  return current?group.conversations[current.ci]?.id:null;
}
async function sessionTab(id) {
  if(!id)return null;
  try {
    const tab=await chrome.tabs.get(id);
    return tab.url?.startsWith(new URL(HOME).origin+'/')?tab:null;
  } catch{return null;}
}
async function openRecordedSession(group,conversationId,sender,{reattachCurrent=false}={}) {
  const session=group?.run?.sessions?.[conversationId];
  if(!session)throw new Error('这个对话还没有建立 AI Studio 执行页面。');
  const current=group.run.current,isCurrent=currentConversationId(group)===conversationId;
  let tab=await sessionTab(session.tabId);
  if(tab) {
    await chrome.tabs.update(tab.id,{active:true});
    if(tab.id===session.tabId && group.run.executionWindowId===tab.windowId)await keepExecutionPageVisible(group,tab.id,{focus:true});
    else await chrome.windows.update(tab.windowId,{focused:true});
    return tab;
  }
  const viewingTab=await sessionTab(session.viewTabId);
  if(reattachCurrent&&isCurrent&&current?.checkpoint&&viewingTab) {
    const kept=await keepExecutionPageVisible(group,viewingTab.id,{focus:true});tab=kept.tab;
    session.tabId=tab.id;delete session.viewTabId;current.tabId=tab.id;current.dispatched=false;current.lastHeartbeat=Date.now();current.lastFocusAt=Date.now();
    log(group,'已重新接管打开的 AI Studio 会话页；继续时只采集已有回复，不重复发送。');await persist(group);return tab;
  }
  if(viewingTab) {
    await chrome.tabs.update(viewingTab.id,{active:true});await chrome.windows.update(viewingTab.windowId,{focused:true});return viewingTab;
  }
  const url=restorableSessionUrl(session);
  if(!url)throw new Error('AI Studio 没有为这个对话生成可恢复的独立地址，记录仍是 new_chat。已保存的 Markdown 回复不会丢失。');
  if(reattachCurrent&&isCurrent&&current?.checkpoint) {
    tab=await createExecutionPage(group,url);
    session.tabId=tab.id;current.tabId=tab.id;current.dispatched=false;current.lastHeartbeat=Date.now();current.lastFocusAt=Date.now();
    await closeOtherExecutionPages(group,tab.id);
    log(group,'已按保存的 AI Studio 会话地址重新打开当前执行页；继续时只采集已有回复，不重复发送。');
    await persist(group);return tab;
  }
  const options={url,active:true};
  if(sender.tab?.windowId)options.windowId=sender.tab.windowId;
  tab=await chrome.tabs.create(options);session.viewTabId=tab.id;
  await chrome.windows.update(tab.windowId,{focused:true});await persist(group);return tab;
}
async function replaceExecutionPage(group,conversation,current) {
  const tab=await createExecutionPage(group);
  group.run.sessions[conversation.id]={...(group.run.sessions[conversation.id]||{}),tabId:tab.id,url:HOME};
  if(current) Object.assign(current,{tabId:tab.id,token:uid(),phase:'preparing',checkpoint:null,dispatched:false,lastHeartbeat:Date.now()});
  log(group,`对话 ${current?.ci+1 || group.conversations.indexOf(conversation)+1} 的原执行页面已失效；本轮尚未发送，已安全新建页面`);
  return tab;
}
async function kick(groupId) {
  const group=await db.get('groups',groupId);
  if(!group || !activeStatus(group.run?.status)) return;
  const run=group.run;
  if(run.status==='pausing' && !run.current) {
    run.status='paused';log(group,'已暂停，已完成的回复保存在本地。');await persist(group);await updatePower();return;
  }
  const next=nextPending(group);
  if(!next) {
    run.status='completed';run.current=null;run.completedAt=now();await closeExecutionWindow(group);log(group,'全部回复已保存，AI Studio 执行窗口已关闭，可以下载 Markdown。');
    await persist(group);await updatePower();await chrome.action.setBadgeText({text:'✓'});await notifyDone(group);return;
  }
  const {ci,ti}=next;
  const conversation=group.conversations[ci];
  let session=run.sessions[conversation.id];
  if(!session) {
    log(group,`创建对话 ${ci+1} 的 AI Studio 页面`);await persist(group);
    const tab=await createExecutionPage(group);
    session=run.sessions[conversation.id]={tabId:tab.id,url:HOME};
    await closeOtherExecutionPages(group,tab.id);
    await persist(group);
  }
  let tab;
  try {tab=await chrome.tabs.get(session.tabId);} catch {
    if(canReplaceExecutionPage(run.current,ti)) {
      tab=await replaceExecutionPage(group,conversation,run.current);
      session=run.sessions[conversation.id];
      await persist(group);
    } else {
      await fail(group,'执行页面已关闭，无法验证已有对话上下文。已保存回复仍可下载；请复制此组创建新的执行计划，安排未完成内容。');return;
    }
  }
  const kept=await keepExecutionPageVisible(group,session.tabId);
  tab=kept.tab;
  if(kept.changed)await persist(group);
  if(!run.current) {
    run.current={token:uid(),ci,ti,tabId:session.tabId,phase:'preparing',checkpoint:null,dispatched:false,lastHeartbeat:Date.now(),lastFocusAt:Date.now()};
    log(group,`对话 ${ci+1} · 第 ${ti+1} 轮，准备发送`);await persist(group);
  }
  if(tab.status!=='complete') return;
  const current=run.current;
  const ping=await tabMessage(session.tabId,{type:'PING'});
  if(!ping?.ok) return; // onUpdated/READY or watchdog retries after the page loads.
  if(ping.value.active===current.token) return;
  if(ping.value.active) return; // Previous result is committed; its runner will emit READY in finally.
  if(current.dispatched && !current.checkpoint) {
    await fail(group,'页面在发送前中断，当前轮次尚未点击 Run。若页面保留的文字和图片与本轮一致，可直接点击“检查后继续”沿用；如不一致，请先清空残留草稿或附件。');return;
  }
  current.dispatched=true;current.lastHeartbeat=Date.now();await persist(group);
  const job={groupId:group.id,token:current.token,turn:conversation.turns[ti],
    settings:settingsFor(group,conversation),firstInConversation:ti===0,timeoutMinutes:group.timeoutMinutes,
    focusIntervalSeconds:run.focusIntervalSeconds||group.focusIntervalSeconds||DEFAULT_FOCUS_INTERVAL_SECONDS,
    checkpoint:current.checkpoint,expectedSystem:session.systemValue,previousReplyIds:ti>0?conversation.turns[ti-1].result?.replyIds:[]};
  const ack=await tabMessage(current.tabId,{type:'EXECUTE',job});
  if(!ack?.ok) {
    // Keep dispatched=true. An uncertain delivery is never equivalent to "not sent".
    log(group,'等待执行页面确认，若页面已刷新会先检查发送记录。');await persist(group);
  }
}

async function getOwnedJob(message,sender) {
  const group=await db.get('groups',message.groupId);
  const current=group?.run?.current;
  if(!current || current.token!==message.token || current.tabId!==sender.tab?.id || !activeStatus(group.run.status))
    throw new Error('该轮次已不处于当前执行状态。');
  return {group,current};
}
const uiTypes=new Set(['LIST','SAVE','DELETE','DUPLICATE','START','PAUSE','RESUME','OPEN_RUN','OPEN_SESSION','DISCOVER_OPTIONS','GET_OPTIONS','EXPORT_MODE']);
const pageTypes=new Set(['READY','ASSET','PROGRESS','PREPARED','ARM','SENT','HEARTBEAT','RESULT','FAIL','OPTIONS_RESULT']);
async function handle(message,sender) {
  const ui=sender.url===chrome.runtime.getURL(resource('manager.html'));
  if(uiTypes.has(message.type) && !ui) throw new Error('此操作只能从拆书工坊页面发起。');
  if(pageTypes.has(message.type) && (!sender.tab || !sender.url?.startsWith('https://aistudio.google.com/')))
    throw new Error('消息不是来自 AI Studio 执行页面。');
  switch(message.type) {
    case 'LIST': return (await db.all('groups')).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    case 'GET_OPTIONS': return await db.get('meta','options') || null;
    case 'OPTIONS_RESULT': {
      const probe=await db.get('meta','probe');
      if(probe?.tabId!==sender.tab.id)throw new Error('不是当前选项检测页面。');
      await db.put('meta',{id:'options',...(message.value||{}),...(message.error?{error:message.error}:{}),at:now(),tabId:sender.tab.id});
      chrome.runtime.sendMessage({type:'OPTIONS_CHANGED'}).catch(()=>{});
      return true;
    }
    case 'EXPORT_MODE': {
      const group=await db.get('groups',message.groupId);
      if(!group||!['plain','headings'].includes(message.mode))throw new Error('导出设置无效。');
      group.exportMode=message.mode;await persist(group);return true;
    }
    case 'SAVE': {
      const group=message.group;
      const old=await db.get('groups',group.id);
      if(old?.run) throw new Error('已执行的组不能修改内容；请复制为新组后编辑。');
      if(old && old.revision!==group.revision) throw new Error('此组已在另一个窗口更改，请刷新后再编辑。');
      group.run=null;await persist(group);return group;
    }
    case 'DELETE': {
      const group=await db.get('groups',message.groupId);
      if(activeStatus(group?.run?.status)) throw new Error('请先暂停执行，再删除此组。');
      await db.remove('groups',message.groupId);
      // Assets may be shared by duplicated groups. Only reclaim unreferenced blobs.
      const keep=new Set((await db.all('groups')).flatMap(g=>g.conversations.flatMap(c=>c.turns.flatMap(t=>t.attachments.map(a=>a.id)))));
      for(const asset of await db.all('assets')) if(!keep.has(asset.id)) await db.remove('assets',asset.id);
      return true;
    }
    case 'DUPLICATE': {
      const source=await db.get('groups',message.groupId);
      if(!source) throw new Error('找不到此组。');
      const group=duplicateGroup(source);await persist(group);return group;
    }
    case 'START': {
      const group=await db.get('groups',message.groupId);
      if(!group) throw new Error('请先保存此组。');
      if(group.run) throw new Error('此组已经启动过，请使用继续，或复制为新组。');
      if(await activeGroup()) throw new Error('已有一个组正在执行，请先完成或暂停该组。');
      validateGroup(group);
      for(const c of group.conversations) for(const t of c.turns) for(const a of t.attachments)
        if(!await db.get('assets',a.id)) throw new Error(`图片“${a.name}”缺失，请重新添加。`);
      let anchor;try{anchor=await chrome.windows.get(sender.tab.windowId);}catch{anchor=await chrome.windows.getLastFocused().catch(()=>null);}
      group.focusIntervalSeconds=group.focusIntervalSeconds??DEFAULT_FOCUS_INTERVAL_SECONDS;
      const requestedExecutionBounds=executionBounds(anchor,message.screen);
      group.run={id:uid(),status:'running',sessions:{},executionWindowId:null,executionBounds:requestedExecutionBounds,requestedExecutionBounds:{...requestedExecutionBounds},layoutVersion:2,focusIntervalSeconds:group.focusIntervalSeconds,current:null,logs:[],startedAt:now(),message:'准备执行',error:null};
      await persist(group);
      await chrome.alarms.create('bookflow-watchdog',{periodInMinutes:0.5});
      await updatePower();await chrome.action.setBadgeText({text:'…'});
      await kick(group.id);return true;
    }
    case 'PAUSE': {
      const group=await db.get('groups',message.groupId);
      if(!activeStatus(group?.run?.status)) return true;
      group.run.status=group.run.current?'pausing':'paused';
      log(group,group.run.current?'将在当前轮次完成并保存后暂停。':'已暂停。');await persist(group);await updatePower();return true;
    }
    case 'RESUME': {
      const group=await db.get('groups',message.groupId);
      if(!group?.run || !['paused','error'].includes(group.run.status)) throw new Error('此组当前不需要恢复。');
      if(await activeGroup()) throw new Error('请先暂停另一个正在执行的组。');
      await refreshExecutionBounds(group,sender,message.screen);
      const current=group.run.current;
      if(current) {
        let tab;try{tab=await chrome.tabs.get(current.tabId);}catch{}
        if(!tab) {
          if(current.checkpoint)tab=await openRecordedSession(group,group.conversations[current.ci].id,sender,{reattachCurrent:true});
          else if(canReplaceExecutionPage(current))tab=await replaceExecutionPage(group,group.conversations[current.ci],current);
          else throw new Error('原执行页面已关闭，且没有可安全接管的发送记录。请下载已有结果，复制此组后重新安排未完成内容。');
          if(!tab)throw new Error('无法重新打开当前 AI Studio 执行页面。');
        } else {
          const kept=await keepExecutionPageVisible(group,current.tabId,{focus:true});tab=kept.tab;
          current.dispatched=false;current.lastHeartbeat=Date.now();
          if(!current.checkpoint) current.token=uid();
          const pageConnection=await tabMessage(current.tabId,{type:'PING'});
          if(!pageConnection?.ok)await chrome.tabs.reload(current.tabId);
        }
      }
      group.run.status='running';group.run.error=null;
      log(group,current?.checkpoint?'恢复采集当前回复，不重复发送。':'继续执行剩余轮次。');
      await persist(group);await updatePower();await kick(group.id);return true;
    }
    case 'OPEN_RUN': {
      const group=await db.get('groups',message.groupId);
      if(!group?.run)throw new Error('此组还没有执行页面。');
      if(await refreshExecutionBounds(group,sender,message.screen))await persist(group);
      const conversationId=currentConversationId(group)||Object.keys(group.run.sessions||{}).at(-1);
      if(!conversationId)throw new Error('此组还没有执行页面。');
      try{await openRecordedSession(group,conversationId,sender,{reattachCurrent:true});}
      catch(error){if(canReplaceExecutionPage(group.run.current))throw new Error('原执行页面已关闭，但当前轮次尚未发送。请点击“检查后继续”，程序会自动新建执行页面。');throw error;}
      return true;
    }
    case 'OPEN_SESSION': {
      const group=await db.get('groups',message.groupId);
      if(!group?.run)throw new Error('此组还没有执行页面记录。');
      if(await refreshExecutionBounds(group,sender,message.screen))await persist(group);
      await openRecordedSession(group,message.conversationId,sender);return true;
    }
    case 'DISCOVER_OPTIONS': {
      if(await activeGroup()) throw new Error('请先暂停当前组，再读取网页选项。');
      let probe=await db.get('meta','probe'),tab;
      if(probe) try{tab=await chrome.tabs.get(probe.tabId);}catch{}
      if(!tab) {tab=await chrome.tabs.create({url:HOME,active:false});await db.put('meta',{id:'probe',tabId:tab.id});}
      // Reply quickly; DISCOVER_RESULT is saved independently of the popup/worker lifetime.
      void discoverOptions(tab.id);
      return {tabId:tab.id};
    }
    case 'READY': {
      const group=await activeGroup();
      if(group && Object.values(group.run.sessions).some(s=>s.tabId===sender.tab.id)) await kick(group.id);
      return true;
    }
  }
  const {group,current}=await getOwnedJob(message,sender);
  current.lastHeartbeat=Date.now();
  const c=group.conversations[current.ci],turn=c.turns[current.ti];
  switch(message.type) {
    case 'ASSET':
      if(!turn.attachments.some(a=>a.id===message.id)) throw new Error('此图片不属于当前轮次。');
      return db.assetToWire(message.id);
    case 'PROGRESS': log(group,message.message);break;
    case 'PREPARED': group.run.sessions[c.id].systemValue=message.systemValue;break;
    case 'ARM':
      if(current.checkpoint) throw new Error('本轮已经记录发送意图，禁止再次发送。');
      current.checkpoint=message.checkpoint;current.phase='armed';log(group,`对话 ${current.ci+1} · 第 ${current.ti+1} 轮，已记录发送意图`);break;
    case 'SENT': current.phase='waiting';log(group,`对话 ${current.ci+1} · 第 ${current.ti+1} 轮，等待 Gemini 回复`);break;
    case 'HEARTBEAT':
      if(Date.now()-(current.lastFocusAt||0)>=(group.run.focusIntervalSeconds||DEFAULT_FOCUS_INTERVAL_SECONDS)*1000-250){
        await keepExecutionPageVisible(group,current.tabId,{focus:true});current.lastFocusAt=Date.now();
      }
      break;
    case 'RESULT':
      if(!current.checkpoint || !message.result?.markdown?.trim()) throw new Error('回复记录不完整，拒绝推进到下一轮。');
      turn.result=message.result;
      group.run.sessions[c.id].url=message.result.url;
      log(group,`对话 ${current.ci+1} · 第 ${current.ti+1} 轮，回复已保存`);
      group.run.current=null; // A single IndexedDB record atomically commits result and cursor.
      await persist(group);
      if(!nextPending(group)) await kick(group.id);
      else if(group.run.status==='pausing') await kick(group.id);
      return true;
    case 'FAIL': await fail(group,message.error);return true;
    default: throw new Error('未知操作。');
  }
  if(message.url) group.run.sessions[c.id].url=message.url;
  await persist(group);return true;
}
async function discoverOptions(tabId) {
  try {
    let ready=false;
    for(let i=0;i<60;i++) {
      const ping=await tabMessage(tabId,{type:'PING'});
      if(ping?.ok){ready=true;break;}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    if(!ready) throw new Error('AI Studio 未就绪，请在新建的网页中登录，再次读取选项。');
    const result=await tabMessage(tabId,{type:'DISCOVER'});
    if(!result?.ok) throw new Error(result?.error||'读取网页选项失败，请检查 AI Studio 是否已登录。');
    return; // The page sends OPTIONS_RESULT when ready; no long-lived background promise.
  } catch(error) {await db.put('meta',{id:'options',error:error.message,at:now(),tabId});}
  chrome.runtime.sendMessage({type:'OPTIONS_CHANGED'}).catch(()=>{});
}

chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(!uiTypes.has(message.type)&&!pageTypes.has(message.type)) return;
  serial(()=>handle(message,sender)).then(value=>respond({ok:true,value}),error=>respond({ok:false,error:error.message}));
  return true;
});
async function openManager() {
  const url=chrome.runtime.getURL(resource('manager.html'));
  const existing=(await chrome.runtime.getContexts({contextTypes:['TAB'],documentUrls:[url]}))[0];
  if(existing){await chrome.tabs.update(existing.tabId,{active:true});await chrome.windows.update(existing.windowId,{focused:true});}
  else await chrome.tabs.create({url});
}
chrome.action.onClicked.addListener(()=>{void openManager();});
chrome.notifications.onClicked.addListener(id=>{if(id.startsWith('bookflow-'))void openManager();});
chrome.tabs.onUpdated.addListener((tabId,change)=>{
  if(change.status!=='complete')return;
  void serial(async()=>{
    const group=await activeGroup();
    if(group && Object.values(group.run.sessions).some(s=>s.tabId===tabId)) await kick(group.id);
  });
});
chrome.tabs.onActivated.addListener(activeInfo=>{
  void serial(async()=>{
    const group=await activeGroup(),current=group?.run?.current;
    if(current && group.run.executionWindowId===activeInfo.windowId && current.tabId!==activeInfo.tabId)
      await keepExecutionPageVisible(group,current.tabId);
  });
});
chrome.tabs.onRemoved.addListener(tabId=>{
  void serial(async()=>{
    const group=await activeGroup();
    if(group?.run.current?.tabId===tabId) await fail(group,'执行页面已关闭，任务已暂停。已完成回复仍保存在本地。');
  });
});
chrome.alarms.onAlarm.addListener(alarm=>{
  if(alarm.name!=='bookflow-watchdog')return;
  void serial(async()=>{
    const group=await activeGroup();
    if(!group){await updatePower();return;}
    const current=group.run.current;
    if(current&&!current.dispatched&&Date.now()-current.lastHeartbeat>45000){
      await fail(group,'执行页面尚未连接。请在同一浏览器登录 AI Studio，并在原执行标签页打开 Playground，然后检查后继续。');return;
    }
    if(current && Date.now()-current.lastHeartbeat>180000) {
      await fail(group,'超过 3 分钟未收到执行页面的状态。请检查登录、网络或标签页是否被休眠，然后检查后继续。');return;
    }
    await kick(group.id);
  });
});
chrome.runtime.onStartup.addListener(()=>{
  void serial(async()=>{
    for(const group of await db.all('groups')) if(activeStatus(group.run?.status)) {
      group.run.status='paused';log(group,'浏览器已重新启动，请检查原执行页面后继续。');await persist(group);
    }
    await chrome.alarms.create('bookflow-watchdog',{periodInMinutes:0.5});await updatePower();
  });
});
chrome.runtime.onInstalled.addListener(()=>{
  chrome.alarms.create('bookflow-watchdog',{periodInMinutes:0.5});
});
