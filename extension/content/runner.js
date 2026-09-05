(() => {
  if(globalThis.__bookflowRunner) return;
  globalThis.__bookflowRunner=true;
  const D=globalThis.BookflowDOM;
  let active=null;
  const rpc=async(type,payload={})=>{
    const response=await chrome.runtime.sendMessage({type,...payload});
    if(!response?.ok) throw new Error(response?.error || '插件连接已断开，请回到拆书工坊恢复检查。');
    return response.value;
  };
  async function observe(job, checkpoint) {
    let lastText='',stableSince=Date.now(),sawBusy=false;
    const initialErrors=new Set(job.initialErrors || []);
    const deadline=Date.now()+job.timeoutMinutes*60000;
    // Observe DOM changes, but also poll: background tabs can batch mutation callbacks.
    let changed=true;
    const observer=new MutationObserver(()=>{changed=true;});
    observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','aria-disabled']});
    try {
      while(Date.now()<deadline) {
        if(active?.token!==job.token) throw new Error('当前执行标识已失效。');
        const errors=D.errorMessages().filter(e=>!initialErrors.has(e));
        if(errors.length) throw new Error(errors.join('\n'));
        if(D.generating()) sawBusy=true;
        const reply=D.replyAfter(checkpoint);
        if(reply) {
          const text=reply.turns.map(t=>D.cleanMarkdown(t)).filter(Boolean).join('\n\n');
          if(changed || text!==lastText) {
            if(text!==lastText) { lastText=text;stableSince=Date.now(); }
            changed=false;
          }
          const final=reply.turns.every(t=>!!D.query(D.S.final,t));
          // A Run label can be disabled after completion. Enabled state is NOT a completion signal.
          if(text.trim() && final && D.idle() && Date.now()-stableSince>=2500) {
            await rpc('RESULT',{groupId:job.groupId,token:job.token,
              result:{markdown:text,source:'rendered-dom',replyIds:reply.turns.map(t=>t.id),userId:reply.userId,url:location.href,completedAt:new Date().toISOString()}});
            return;
          }
        }
        await D.pause(500);
      }
      throw new Error(`等待超过 ${job.timeoutMinutes} 分钟，尚未确认正式回复完整结束。已保留当前轮次，可检查网页后恢复采集；不会自动重发。${sawBusy?'':'（尚未观察到生成状态）'}`);
    } finally { observer.disconnect(); }
  }
  async function execute(job) {
    const focusInterval=Math.max(2,Math.min(120,Number(job.focusIntervalSeconds)||10));
    const beat=setInterval(()=>rpc('HEARTBEAT',{groupId:job.groupId,token:job.token,url:location.href,visibility:document.visibilityState}).catch(()=>{}),Math.min(15000,focusInterval*1000));
    try {
      let checkpoint=job.checkpoint;
      if(!checkpoint) {
        await D.until(()=>D.query(D.S.prompt),{timeout:45000,message:'AI Studio 尚未就绪，请检查登录状态并进入 Playground。'});
        if(D.generating()) throw new Error('页面正在生成其他回复，请等待它结束后继续。');
        if(job.firstInConversation && D.many(D.S.turns).length) throw new Error('新对话页面包含已有消息，已停止，防止串入其他上下文。');
        if(!job.firstInConversation && job.previousReplyIds?.length && !job.previousReplyIds.every(id=>document.getElementById(id)))
          throw new Error('无法核对上一轮对话上下文，请回到原执行页面后继续。');
        if(job.firstInConversation) {
          await rpc('PROGRESS',{groupId:job.groupId,token:job.token,message:'设置模型与系统指令'});
          await D.setModel(job.settings.model);
          const systemValue=await D.setSystem(job.settings.system);
          await rpc('PREPARED',{groupId:job.groupId,token:job.token,systemValue});
        } else if(!(await D.modelMatches(job.settings.model))) {
          throw new Error('本对话的模型被更改，请恢复原模型后继续。');
        }
        if(!job.firstInConversation&&job.expectedSystem?.trim()&&
          !D.normalized(D.query(D.S.systemButton)?.textContent).includes(D.normalized(job.expectedSystem)))
          throw new Error('本对话的系统指令与执行计划不一致，请检查原指令后继续。');
        await rpc('PROGRESS',{groupId:job.groupId,token:job.token,message:'确认 Code execution、Google Search 与 URL context 均已关闭'});
        await D.disableOptionalTools();
        job.initialErrors=D.errorMessages();
        if(job.initialErrors.length) throw new Error(job.initialErrors.join('\n'));
        await D.fillTurn(job.turn,id=>rpc('ASSET',{groupId:job.groupId,token:job.token,id}),
          message=>rpc('PROGRESS',{groupId:job.groupId,token:job.token,message}));
        checkpoint=D.baseline();
        // Persist the send intention BEFORE clicking. A lost acknowledgement can never cause a retry click.
        await rpc('ARM',{groupId:job.groupId,token:job.token,checkpoint});
        if(!D.enabled(D.query(D.S.run)) || !D.idle()) throw new Error('准备发送时页面状态改变，请检查网页后恢复采集。');
        D.query(D.S.run).click();
        await rpc('SENT',{groupId:job.groupId,token:job.token,url:location.href});
      }
      await observe(job,checkpoint);
    } catch(error) {
      await rpc('FAIL',{groupId:job.groupId,token:job.token,error:error.message}).catch(()=>{});
    } finally {
      clearInterval(beat);
      if(active?.token===job.token) active=null;
      rpc('READY').catch(()=>{});
    }
  }
  chrome.runtime.onMessage.addListener((message,_sender,respond)=>{
    if(message.type==='PING') { respond({ok:true,value:{active:active?.token||null,url:location.href}}); return; }
    if(message.type==='EXECUTE') {
      if(active) { respond({ok:active.token===message.job.token,error:'执行页面仍在处理另一个轮次。'});return; }
      active={token:message.job.token};
      respond({ok:true});
      void execute(message.job);
      return;
    }
    if(message.type==='DISCOVER') {
      if(active) {respond({ok:false,error:'执行中不能读取或修改模型列表。'});return;}
      active={token:'discovery'};
      respond({ok:true});
      void D.discover().then(value=>rpc('OPTIONS_RESULT',{value}),error=>rpc('OPTIONS_RESULT',{error:error.message}))
        .catch(()=>{}).finally(()=>{active=null;});
      return;
    }
  });
  rpc('READY').catch(()=>{});
})();
