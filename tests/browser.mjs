import {chromium} from 'playwright';
import {readFile,mkdir,writeFile,cp,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=path.resolve('.'),out=path.join(root,'test-results');
await mkdir(out,{recursive:true});
const runStamp=Date.now();
const fixture=await readFile(path.join(root,'tests/fixtures/aistudio.html'),'utf8');
let responseDelay=0;
const server=createServer((_req,res)=>{const send=()=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(fixture);};responseDelay?setTimeout(send,responseDelay):send();});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}/`;
// Only the site origin changes in this test copy. Real extension code, browser APIs and storage remain intact.
const extension=path.join(out,'harness-extension-'+runStamp);
const profile=path.join(out,'profile-'+runStamp);
await cp(path.join(root,'extension'),extension,{recursive:true});
for(const file of ['manifest.json','background.js']){
  const filePath=path.join(extension,file);
  await writeFile(filePath,(await readFile(filePath,'utf8')).replaceAll('https://aistudio.google.com/',base));
}
const context=await chromium.launchPersistentContext(profile,{
  channel:'chromium',...(process.env.BOOKFLOW_TEST_BROWSER?{executablePath:process.env.BOOKFLOW_TEST_BROWSER}:{}),headless:true,viewport:{width:1480,height:1040},
  ignoreDefaultArgs:['--disable-extensions'],
  args:['--enable-unsafe-extension-debugging','--window-size=1480,1040','--screen-size=1480,1040'],
});
const errors=[];
context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
let page;
async function waitState(predicate,timeout=20000){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    const g=await page.evaluate(async()=> (await chrome.runtime.sendMessage({type:'LIST'})).value[0]);
    if(predicate(g))return g;
    if(g?.run?.status==='error')throw new Error(g.run.error);
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw new Error('Timed out waiting for extension state');
}
try{
  const browserSession=await context.browser().newBrowserCDPSession();
  const {id}=await browserSession.send('Extensions.loadUnpacked',{path:extension});
  page=await context.newPage();
  await page.goto(`chrome-extension://${id}/manager.html`);
  await page.getByRole('button',{name:'创建第一个拆书组'}).waitFor();
  await page.screenshot({path:path.join(out,'empty-desktop.png'),fullPage:true});
  const embeddedIcon=(await readFile(path.join(extension,'icons/128.png'))).toString('base64');
  const importPackage={
    format:'aistudio-bookflow',version:1,groups:[{
      name:'Codex 导入测试',model:'gemini-2.5-pro',system:'只根据提供的原文拆解。',timeoutMinutes:25,focusIntervalSeconds:17,exportMode:'headings',
      conversations:[
        {title:'导入对话 A',turns:[
          {title:'导入第 1 章',text:'导入正文 1',attachments:[{name:'导入图片.png',type:'image/png',base64:embeddedIcon}]},
          {title:'导入第 2 章',text:'导入正文 2'},
        ]},
        {title:'导入对话 B',model:'gemini-3.1-pro-preview',system:{mode:'none'},turns:[{title:'导入第 3 章',text:'导入正文 3'}]},
      ],
    }],
  };
  const packageDrop=await page.evaluate(payload=>{
    const target=document.querySelector('.empty-package-import'),file=new File([JSON.stringify(payload)],'codex-test.bookflow.json',{type:'application/json'}),dataTransfer=new DataTransfer();
    dataTransfer.items.add(file);target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer}));
    const highlighted=target.classList.contains('dragging');target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer}));
    return {highlighted,cleared:!target.classList.contains('dragging')};
  },importPackage);
  assert.deepEqual(packageDrop,{highlighted:true,cleared:true},'task package supports a visible drag-and-drop state');
  await page.locator('.conversation').nth(1).waitFor();
  assert.equal(await page.locator('.conversation').count(),2,'package creates all conversations');
  assert.equal(await page.locator('.turn').count(),3,'package creates all turns');
  assert.equal(await page.locator('input[data-field="group-name"]').inputValue(),'Codex 导入测试');
  assert.equal(await page.getByRole('textbox',{name:'System instructions',exact:true}).inputValue(),'只根据提供的原文拆解。');
  assert.equal(await page.locator('.prompt-editor').first().inputValue(),'导入正文 1');
  await page.locator('.attachment img').waitFor();
  const importedState=await page.evaluate(async()=> (await chrome.runtime.sendMessage({type:'LIST'})).value[0]);
  assert.deepEqual(importedState.conversations.map(c=>c.turns.length),[2,1]);
  assert.equal(importedState.conversations[1].model,'gemini-3.1-pro-preview');
  assert.equal(importedState.conversations[1].system.mode,'none');
  assert.equal(importedState.focusIntervalSeconds,17);
  assert.equal(importedState.run,null);
  assert.ok(importedState.conversations.every(c=>c.turns.every(t=>t.result===null)));
  await page.getByRole('button',{name:'删除此组'}).click();
  await page.locator('#confirm-dialog').getByRole('button',{name:'删除',exact:true}).click();
  await page.getByRole('button',{name:'创建第一个拆书组'}).waitFor();
  await page.getByRole('button',{name:'新建组',exact:true}).click();
  await page.locator('#create-form input[name=name]').fill('周期 · 全书拆解');
  await page.locator('#create-form input[name=conversationCount]').fill('3');
  for(const [i,value] of [3,3,4].entries())await page.locator('#conversation-rounds input[name=rounds]').nth(i).fill(String(value));
  await page.getByRole('button',{name:'创建组',exact:true}).click();
  await page.locator('.conversation').nth(2).waitFor();
  assert.equal(await page.locator('.conversation').count(),3);
  assert.equal(await page.locator('.turn').count(),10);
  await page.locator('#chapter-picker').setInputFiles(Array.from({length:10},(_,i)=>({
    name:`${String(i+1).padStart(2,'0')} ${['周期的意义','周期的性质','周期的规律','经济周期','政府干预','企业盈利','投资人心理','信贷周期','市场周期','如何应对'][i]}.md`,
    mimeType:'text/markdown',buffer:Buffer.from(`章节 ${i+1}${i===0?' LONG_GAP':''}`),
  })));
  await page.waitForFunction(()=>document.querySelector('.prompt-editor')?.value==='章节 1 LONG_GAP');
  await page.getByRole('textbox',{name:'System instructions',exact:true}).fill('按原文输出多级 Markdown 列表。');
  await page.locator('[data-field="focus-interval"]').fill('2');
  const chooserPromise=page.waitForEvent('filechooser');
  await page.getByRole('button',{name:'添加图片',exact:true}).click();
  const chooser=await chooserPromise;
  await chooser.setFiles({name:'章节框架.png',mimeType:'image/png',buffer:await readFile(path.join(extension,'icons/128.png'))});
  await page.locator('.attachment img').waitFor();
  await page.locator('.conversation').nth(1).getByRole('button',{name:'设置本对话'}).click();
  await page.getByLabel('Model selection',{exact:true}).fill('gemini-3.1-pro-preview');
  await page.locator('[data-field=system-mode]').selectOption('preset');
  await page.getByLabel('系统指令预设名称',{exact:true}).fill('经济类拆书');
  await page.getByRole('button',{name:'组设置',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.save-label')?.textContent==='已保存到本地');
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:path.join(out,'editor-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:path.join(out,'editor-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'no mobile horizontal overflow');
  await page.setViewportSize({width:1480,height:1040});
  await page.getByRole('button',{name:'开始串行执行'}).click();
  const firstWaiting=await waitState(g=>g.run?.current?.phase==='waiting');
  const firstPlacement=await page.evaluate(async({tabId,executionWindowId})=>{
    const manager=await chrome.tabs.getCurrent(),execution=await chrome.tabs.get(tabId),window=await chrome.windows.get(executionWindowId);
    return {managerWindowId:manager.windowId,executionWindowId,tabWindowId:execution.windowId,active:execution.active,autoDiscardable:execution.autoDiscardable,windowState:window.state,focused:window.focused,left:window.left,top:window.top,width:window.width,height:window.height};
  },{tabId:firstWaiting.run.current.tabId,executionWindowId:firstWaiting.run.executionWindowId});
  assert.notEqual(firstPlacement.executionWindowId,firstPlacement.managerWindowId,'AI Studio uses a dedicated window');
  assert.equal(firstPlacement.tabWindowId,firstPlacement.executionWindowId);
  assert.equal(firstPlacement.active,true,'current AI Studio page remains the active tab of its window');
  assert.equal(firstPlacement.autoDiscardable,false);
  assert.notEqual(firstPlacement.windowState,'minimized');
  assert.ok(firstWaiting.run.requestedExecutionBounds.width>=1000&&firstWaiting.run.requestedExecutionBounds.width<=1400,'execution page requests enough width for the full AI Studio settings panel');
  assert.ok(firstWaiting.run.requestedExecutionBounds.height>=680&&firstWaiting.run.requestedExecutionBounds.height<=1000,'execution window requests enough vertical room');
  await page.evaluate(windowId=>chrome.windows.update(windowId,{focused:true}),firstPlacement.managerWindowId);
  await page.waitForFunction(async windowId=>(await chrome.windows.get(windowId)).focused,firstPlacement.executionWindowId,{timeout:5000});
  const distractor=await page.evaluate(windowId=>chrome.tabs.create({windowId,url:'about:blank',active:true}),firstPlacement.executionWindowId);
  await page.waitForFunction(async tabId=>(await chrome.tabs.get(tabId)).active,firstWaiting.run.current.tabId,{timeout:5000});
  assert.equal(await page.evaluate(tabId=>chrome.tabs.get(tabId).then(tab=>tab.active),distractor.id),false,'switching inside the execution window immediately restores the running AI Studio tab');
  await page.evaluate(tabId=>chrome.tabs.remove(tabId),distractor.id);
  await page.getByRole('button',{name:'本轮完成后暂停'}).click();
  await waitState(g=>g.run?.status==='paused');
  let saved=await page.evaluate(async()=> (await chrome.runtime.sendMessage({type:'LIST'})).value[0]);
  assert.equal(saved.conversations.flatMap(c=>c.turns).filter(t=>t.result).length,1,'pause commits exactly current round');
  assert.ok(saved.conversations[0].turns[0].result.markdown.includes('完成 章节 1'));
  assert.ok(!saved.conversations[0].turns[0].result.markdown.includes('尚未输出完毕'));
  console.log('PASS real extension: planning, image storage/upload, long stream gap, graceful pause, first checkpoint');
  await page.getByRole('button',{name:'继续执行',exact:true}).click();
  await waitState(g=>g.run?.current?.ti===1&&g.run.current.phase==='waiting');
  // Terminate the actual MV3 service worker while a round is generating.
  const cdp=await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  const managerURL=page.url();
  await page.close();
  const finishBy=Date.now()+90000;
  let completedInBrowser=false;
  while(Date.now()<finishBy){
    const live=context.pages().filter(p=>p.url().startsWith(base));
    if(live.length===0){completedInBrowser=true;break;}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.ok(completedInBrowser,'execution continues with manager closed and closes its window when done');
  page=await context.newPage();await page.goto(managerURL);
  await waitState(g=>g.run?.status==='completed',90000);
  saved=await page.evaluate(async()=> (await chrome.runtime.sendMessage({type:'LIST'})).value[0]);
  const replies=saved.conversations.flatMap(c=>c.turns.map(t=>t.result.markdown));
  assert.equal(replies.length,10);replies.forEach((md,i)=>{
    assert.ok(md.includes(`完成 章节 ${i+1}`));assert.ok(!md.includes('THOUGHT_ONLY_DO_NOT_EXPORT'));assert.ok(md.includes('    -'));
  });
  assert.equal(saved.run.executionWindowId,null,'the dedicated execution window closes after the group finishes');
  assert.equal(context.pages().filter(p=>p.url().startsWith(base)).length,0,'completed conversation pages do not accumulate');
  const eventAudit=await context.newPage();await eventAudit.goto(base);
  const events=await eventAudit.evaluate(()=>window.allFixtureEvents().filter(list=>list.some(e=>e.type==='send')));
  await eventAudit.close();
  assert.deepEqual(events.map(list=>list.filter(e=>e.type==='send').length),[3,3,4]);
  assert.deepEqual(events.map(list=>list.filter(e=>e.type==='tool-off').map(e=>e.name)),[
    ['Code execution','Grounding with Google Search','URL context'],
    ['Code execution','Grounding with Google Search','URL context'],
    ['Code execution','Grounding with Google Search','URL context'],
  ]);
  const allEvents=events.flat().sort((a,b)=>(a.at||0)-(b.at||0));
  const sends=allEvents.filter(e=>e.type==='send');
  assert.equal(sends.length,10,'no duplicate sends after service-worker restart');
  assert.ok(sends.every(e=>e.visibility==='visible'),'every Gemini send starts in a visible active execution tab');
  assert.equal(sends[0].images,1);assert.equal(events[0].find(e=>e.type==='upload').names[0],'章节框架.png');
  sends.forEach((e,i)=>{
    assert.equal(e.toolsOn,0,'all three optional tools are off before every send');
    assert.equal(e.model,i>=3&&i<6?'gemini-3.1-pro-preview':'gemini-2.5-pro');
    assert.equal(e.system,i>=3&&i<6?'按原文整理成多级 Markdown 列表。':'按原文输出多级 Markdown 列表。');
    if(i>0){const prevComplete=allEvents.filter(x=>x.type==='complete'&&x.at<e.at).length;assert.equal(prevComplete,i,'strict global serial completion');}
  });
  await page.getByRole('button',{name:/汇总文档/}).click();
  const downloadPromise=page.waitForEvent('download');
  await page.getByRole('button',{name:'下载 Markdown',exact:true}).click();
  const download=await downloadPromise;
  assert.equal(download.suggestedFilename(),'周期 · 全书拆解.md');
  await download.saveAs(path.join(out,'test-result.md'));
  const md=await readFile(path.join(out,'test-result.md'),'utf8');
  assert.ok(md.startsWith('-'));assert.equal(md.match(/完成 章节 /g).length,10);assert.ok(!md.includes('THOUGHT_ONLY'));
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:path.join(out,'completed-desktop.png'),fullPage:true});
  await page.reload();await page.locator('.status-pill.completed').waitFor();
  await page.getByRole('button',{name:'运行与结果'}).click();
  assert.equal(await page.locator('.session-page-row').count(),3,'all AI Studio conversation page addresses remain listed after completion and reload');
  const reopenPromise=context.waitForEvent('page');
  await page.locator('.session-page-row').first().getByRole('button',{name:'打开'}).click();
  const reopenedPage=await reopenPromise;await reopenedPage.waitForLoadState('domcontentloaded');
  assert.match(reopenedPage.url(),/\/app\/prompts\/(?!new_chat)[^/]+$/,'a closed conversation reopens from its recorded AI Studio URL');
  await reopenedPage.close();await page.bringToFront();
  await page.screenshot({path:path.join(out,'completed-runtime-desktop.png'),fullPage:true});
  console.log('PASS real extension: 3/3/4 strict serial flow, per-conversation overrides, MV3 worker restart, manager closed, ordered Markdown download, saved conversation URLs, persistence after manager reload');
  // An uncertain submitted round must recover by observing after page reload, never clicking Run again.
  await page.getByRole('button',{name:'新建组',exact:true}).click();
  await page.locator('#create-form input[name=name]').fill('异常恢复测试');
  await page.locator('#create-form input[name=conversationCount]').fill('1');
  await page.locator('#conversation-rounds input[name=rounds]').fill('1');
  await page.getByRole('button',{name:'创建组',exact:true}).click();
  await page.getByLabel('本轮文字内容',{exact:true}).fill('章节恢复 RECOVER_TEST');
  await page.getByRole('button',{name:'开始串行执行'}).click();
  const interrupted=await waitState(g=>g.run?.status==='error');
  assert.ok(interrupted.run.current.checkpoint);
  const recoveryPage=context.pages().filter(p=>p.url().startsWith(base)).at(-1);
  await recoveryPage.evaluate(()=>{document.querySelector('[role=alert]').remove();window.completePending();});
  await recoveryPage.reload();
  await page.getByRole('button',{name:'检查后继续'}).click();
  const recovered=await waitState(g=>g.run?.status==='completed');
  assert.equal(recovered.conversations[0].turns.filter(t=>t.result).length,1);
  const recoveryAudit=await context.newPage();await recoveryAudit.goto(base);
  assert.equal(await recoveryAudit.evaluate(()=>window.allFixtureEvents().flat().filter(e=>e.type==='send'&&e.text==='章节恢复 RECOVER_TEST').length),1);
  await recoveryAudit.close();
  console.log('PASS real extension: submitted-round error + content page reload + resume saves result without resending');
  // A submitted page may be closed after AI Studio has assigned a stable conversation URL.
  // Resume must reopen that URL and observe the saved reply without a second Run click.
  await page.getByRole('button',{name:'新建组',exact:true}).click();
  await page.locator('#create-form input[name=name]').fill('关闭页面后按会话地址恢复');
  await page.locator('#create-form input[name=conversationCount]').fill('1');
  await page.locator('#conversation-rounds input[name=rounds]').fill('1');
  await page.getByRole('button',{name:'创建组',exact:true}).click();
  await page.getByLabel('本轮文字内容',{exact:true}).fill('关闭恢复 CLOSE_RECOVER_TEST');
  await page.getByRole('button',{name:'开始串行执行'}).click();
  const closedInterrupted=await waitState(g=>g.run?.status==='error');
  const closedTabId=closedInterrupted.run.current.tabId;
  assert.ok(closedInterrupted.run.current.checkpoint);
  assert.match(closedInterrupted.run.sessions[closedInterrupted.conversations[0].id].url,/\/app\/prompts\/(?!new_chat)[^/]+$/);
  await new Promise(resolve=>setTimeout(resolve,1200));
  await page.evaluate(tabId=>chrome.tabs.remove(tabId),closedTabId);
  await page.getByRole('button',{name:'检查后继续'}).click();
  const closedRecovered=await waitState(g=>g.run?.status==='completed',30000);
  assert.notEqual(closedRecovered.run.sessions[closedRecovered.conversations[0].id].tabId,closedTabId,'resume reattaches the recorded conversation to a new tab');
  const closedRecoveryAudit=await context.newPage();await closedRecoveryAudit.goto(base);
  assert.equal(await closedRecoveryAudit.evaluate(()=>window.allFixtureEvents().flat().filter(e=>e.type==='send'&&e.text==='关闭恢复 CLOSE_RECOVER_TEST').length),1);
  await closedRecoveryAudit.close();
  console.log('PASS real extension: closed submitted page reopens from the recorded conversation URL and resumes collection without resending');
  // Losing a page before ARM/Run on the first round is safe to recover with a fresh page.
  await page.getByRole('button',{name:'新建组',exact:true}).click();
  await page.locator('#create-form input[name=name]').fill('发送前页面恢复测试');
  await page.locator('#create-form input[name=conversationCount]').fill('1');
  await page.locator('#conversation-rounds input[name=rounds]').fill('1');
  await page.getByRole('button',{name:'创建组',exact:true}).click();
  await page.getByLabel('本轮文字内容',{exact:true}).fill('发送前安全恢复');
  responseDelay=5000;
  await page.getByRole('button',{name:'开始串行执行'}).click();
  const beforeClose=await waitState(g=>g.run?.current?.phase==='preparing'&&!g.run.current.checkpoint);
  const staleTabId=beforeClose.run.current.tabId;
  await page.evaluate(tabId=>chrome.tabs.remove(tabId),staleTabId);
  responseDelay=0;
  const pageLost=await waitState(g=>g.run?.status==='error');
  assert.equal(pageLost.run.current.checkpoint,null);
  const openResult=await page.evaluate(async groupId=>chrome.runtime.sendMessage({type:'OPEN_RUN',groupId}),pageLost.id);
  assert.equal(openResult.ok,false);
  assert.match(openResult.error,/尚未发送.*检查后继续/);
  await page.getByRole('button',{name:'检查后继续'}).click();
  const rebuilt=await waitState(g=>g.run?.status==='completed',30000);
  assert.notEqual(rebuilt.run.sessions[rebuilt.conversations[0].id].tabId,staleTabId);
  const rebuiltTabId=rebuilt.run.sessions[rebuilt.conversations[0].id].tabId;
  const rebuiltExists=await page.evaluate(async tabId=>{try{await chrome.tabs.get(tabId);return true;}catch{return false;}},rebuiltTabId);
  assert.equal(rebuiltExists,false,'the final recovered execution page closes after its result is saved');
  const rebuiltAudit=await context.newPage();await rebuiltAudit.goto(base);
  assert.equal(await rebuiltAudit.evaluate(()=>window.allFixtureEvents().flat().filter(e=>e.type==='send'&&e.text==='发送前安全恢复').length),1);
  await rebuiltAudit.close();
  console.log('PASS real extension: missing first-round page before send is recreated; stale tab errors are user-readable');
  assert.deepEqual(errors,[],'no page JavaScript errors');
  await writeFile(path.join(out,'browser-report.json'),JSON.stringify({passed:true,packageImport:true,packageDragDrop:true,packageImportImages:true,rounds:10,conversations:3,dedicatedExecutionWindow:true,largeExecutionWindow:true,recordedConversationPages:true,reopenClosedConversationPage:true,closedSubmittedPageReattached:true,periodicForeground:true,previousConversationPagesClosed:true,completedExecutionWindowClosed:true,activeTabRecovery:true,allSendsVisible:sends.every(e=>e.visibility==='visible'),optionalToolsOff:true,serviceWorkerRestart:true,managerClosed:true,images:true,pauseResume:true,submittedReloadRecovery:true,preSendPageRecreated:true,sends:sends.length,errors,at:new Date().toISOString()},null,2));
}catch(error){
  if(page){await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});console.error(await page.evaluate(()=>document.body.innerText).catch(()=>''));}
  if(page)console.error('STATE',JSON.stringify(await page.evaluate(async()=>({groups:(await chrome.runtime.sendMessage({type:'LIST'})).value?.map(g=>g.run),tabs:await chrome.tabs.query({}),permissions:await chrome.permissions.getAll()})).catch(()=>''),null,2));
  for(const p of context.pages())console.error('PAGE',p.url(),await p.evaluate(()=>({text:document.body.innerText.slice(0,1500),events:window.events})).catch(()=>''));
  console.error(errors);throw error;
}finally{
  await context.close();await new Promise(resolve=>server.close(resolve));
  await rm(profile,{recursive:true,force:true});
  await rm(extension,{recursive:true,force:true});
}
