/* Selectors verified against the snapshots in 1.zip, 2.zip and 3.zip. */
(() => {
  'use strict';
  const S = Object.freeze({
    prompt: 'ms-prompt-box textarea[aria-label="Enter a prompt"]',
    upload: 'ms-prompt-box input[data-test-upload-file-input]',
    run: 'ms-run-button button',
    model: 'ms-model-selector button.model-selector-card,ms-model-selector button.model-selector-trigger',
    modelName: 'ms-model-selector [data-test-id="model-name"]',
    modelTitle: 'ms-model-selector button.model-selector-trigger .title',
    modelOptions: 'button[id^="model-carousel-row-models/"]',
    systemButton: 'button[aria-label="System instructions"]',
    systemText: 'ms-system-instructions textarea[aria-label="System instructions"]',
    systemSelect: 'ms-system-instructions mat-select[role="combobox"]',
    toolRemovers: 'button[aria-label="Remove Code execution"],button[aria-label="Remove Grounding with Google Search"],button[aria-label="Remove URL context"]',
    toolSwitches: 'button[role="switch"][aria-label="Code execution"],button[role="switch"][aria-label="Grounding with Google Search"],button[role="switch"][aria-label="Browse the url context"],button[role="switch"][aria-label="URL context"]',
    turns: 'ms-chat-turn',
    final: 'button[aria-label="Good response"]',
  });
  const query = (selector, root = document) => root.querySelector(selector);
  const many = (selector, root = document) => [...root.querySelectorAll(selector)];
  const normalized = text => (text || '').replace(/\s+/g,' ').trim();
  const visible = element => !!element && !element.hidden && element.getAttribute('aria-hidden') !== 'true' &&
    getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden' && element.getClientRects().length > 0;
  const enabled = element => !!element && !element.disabled && element.getAttribute('aria-disabled') !== 'true' && element.getAttribute('data-disabled') !== 'true';
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(check, { timeout = 15000, message = '页面控件没有按预期出现。', signal } = {}) {
    const deadline = Date.now() + timeout;
    do {
      if (signal?.aborted) throw new Error('本轮操作已停止。');
      const result = await check();
      if (result) return result;
      await pause(250);
    } while (Date.now() < deadline);
    throw new Error(typeof message === 'function' ? message() : message);
  }
  function setValue(element, value) {
    if (!element || !enabled(element)) throw new Error('页面输入框不可编辑，请检查 AI Studio 页面。');
    const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true }));
  }
  function runLabel() {
    const button = query(S.run);
    return normalized(button?.querySelector('.run-button-label')?.textContent || button?.getAttribute('aria-label') || button?.textContent);
  }
  function generating() {
    return /\b(stop|cancel)\b|停止|取消生成/i.test(runLabel()) ||
      many('ms-run-button .material-symbols-outlined').some(e => /^(stop|stop_circle)$/.test(normalized(e.textContent)));
  }
  function idle() { return /^run\b|^运行|^发送/i.test(runLabel()) && !generating(); }
  function userTurn(turn) { return !!query('[data-turn-role="User"],.chat-turn-container.user',turn); }
  function modelTurn(turn) { return !!query('[data-turn-role="Model"],.chat-turn-container.model',turn); }
  // AI Studio keeps an empty User-role chat turn in the transcript as the
  // composer for the next prompt.  It can appear at the same time as the real
  // submitted user turn, and virtual scrolling may later remove the submitted
  // turn's text while retaining its *-chunk-host class.  Treat only committed
  // chunk hosts (or turns that still contain prompt/media content) as messages.
  function submittedUserTurn(turn) {
    if(!userTurn(turn)) return false;
    if([...turn.classList].some(name=>/-chunk-host$/.test(name))) return true;
    const role=query('[data-turn-role="User"],.chat-turn-container.user',turn)||turn;
    if(query('ms-prompt-chunk,ms-text-chunk,ms-image-chunk,ms-prompt-media,[data-test-id="prompt-media-container"]',role)) return true;
    const text=normalized(role.textContent).replace(/^(edit\s*)?(more_vert\s*)?/i,'').trim();
    return !!text;
  }
  function thoughtOnly(turn) {
    return turn.classList.contains('thought-activity-host') || (!!query('ms-thought-chunk',turn) && !many('ms-text-chunk',turn).some(e => !e.closest('ms-thought-chunk')));
  }
  function finalTurns(root = document) { return many(S.turns,root).filter(t => modelTurn(t) && !thoughtOnly(t)); }
  function baseline() {
    return { turnIds: many(S.turns).map(t => t.id), url: location.href, capturedAt: Date.now() };
  }
  function replyAfter(checkpoint) {
    const turns = many(S.turns);
    const known = new Set(checkpoint.turnIds||[]);
    const users = turns.filter(t => !known.has(t.id) && submittedUserTurn(t));
    if (users.length > 1) throw new Error('检测到本轮之外的新消息。已暂停，请检查执行页面是否被手动操作。');
    if (users.length !== 1) return null;
    const anchor = turns.indexOf(users[0]);
    const replies = turns.slice(anchor+1).filter(t => !known.has(t.id) && modelTurn(t) && !thoughtOnly(t));
    return replies.length ? { userId: users[0].id, turns: replies } : null;
  }
  function errorMessages() {
    // Deliberately exclude the invisible tooltip registry: it contains stale API-key warnings.
    return many('[role="alert"],ms-error-message,.error-message,ms-prompt-error,mat-snack-bar-container')
      .filter(visible).map(e => normalized(e.textContent)).filter(t => /error|failed|quota|limit|denied|blocked|unavailable|permission|sign in|出错|错误|失败|限制|配额|登录|禁止|不可用/i.test(t));
  }
  function cleanMarkdown(turn) {
    const chunks = many('ms-text-chunk',turn).filter(e => !e.closest('ms-thought-chunk'));
    if (!chunks.length) return '';
    const root = document.createElement('div');
    for (const chunk of chunks) root.append(chunk.cloneNode(true));
    for (const codeBlock of many('ms-code-block',root)) {
      const pre = query('pre',codeBlock);
      if (!pre) throw new Error('回复中有尚未展开的代码块，无法确认内容完整。请在网页展开后继续。');
      const copy = pre.cloneNode(true);
      const language = codeBlock.getAttribute('data-test-language');
      if (language && query('code',copy)) query('code',copy).className = `language-${language}`;
      codeBlock.replaceWith(copy);
    }
    for (const e of many('button,svg,style,script,ms-thought-chunk,.actions-container,.turn-information,.turn-footer,[aria-hidden="true"]',root)) e.remove();
    // Angular wraps every list item in a custom element. Unwrap before list conversion.
    for (const e of many('*',root).reverse()) if (e.tagName.includes('-')) e.replaceWith(...e.childNodes);
    const converter = new TurndownService({ headingStyle:'atx', codeBlockStyle:'fenced', bulletListMarker:'-', emDelimiter:'*' });
    if (globalThis.turndownPluginGfm) converter.use(globalThis.turndownPluginGfm.gfm);
    converter.addRule('safeLinks', {
      filter: node => node.nodeName === 'A',
      replacement: (content,node) => {
        const href = node.getAttribute('href') || '';
        return /^(https?:|mailto:|#)/i.test(href) ? `[${content}](${href.replace(/\)/g,'%29')})` : content;
      }
    });
    converter.addRule('plainMarkdownCode', {
      filter: node => node.nodeName === 'PRE' && node.parentNode === root && /language-(markdown|md)$/.test(query('code',node)?.className || ''),
      replacement: (_content,node) => '\n\n' + (query('code',node)?.textContent || node.textContent).trim() + '\n\n'
    });
    return converter.turndown(root).trim();
  }
  async function closePanel(containing) {
    const panel = containing?.closest('mat-dialog-container,.cdk-overlay-pane');
    const close = panel && query('button[aria-label="Close panel"]',panel);
    if (close) { close.click(); await until(() => !containing.isConnected || !visible(containing)); }
  }
  async function openModels() {
    const button = await until(() => query(S.model), {message:'找不到模型选择器。请在 AI Studio 的 Playground 页面打开 Run settings。'});
    if (!many(S.modelOptions).some(visible)) button.click();
    await until(() => many(S.modelOptions).some(visible), {message:'无法展开 Model selection，网页结构可能已更新。'});
  }
  const modelId = option => option?.id?.replace('model-carousel-row-models/','') || '';
  const modelTitle = option => normalized(query('.model-title-text',option)?.textContent) || modelId(option);
  function currentModelMatches(model, expectedTitle = '') {
    const legacyId = normalized(query(S.modelName)?.textContent);
    if (legacyId) return legacyId === model;
    const title = normalized(query(S.modelTitle)?.textContent);
    return !!title && !!expectedTitle && title === normalized(expectedTitle);
  }
  async function findModelOption(model) {
    let option = many(S.modelOptions).find(e => modelId(e) === model);
    if (!option) {
      const search = query('input[placeholder="Search for a model or agent"]');
      if (search) setValue(search,model);
      option = await until(() => many(S.modelOptions).find(e => modelId(e) === model), {message:`网页里没有找到模型 ${model}，请重新读取模型列表。`});
    }
    return option;
  }
  async function setModel(model) {
    if (normalized(query(S.modelName)?.textContent) === model) return;
    await openModels();
    const option = await findModelOption(model);
    const expectedTitle = modelTitle(option);
    if (currentModelMatches(model,expectedTitle)) {
      await closePanel(option);
      return;
    }
    if (!enabled(option)) throw new Error(`当前账号无法选择 ${model}。`);
    option.click();
    await until(() => currentModelMatches(model,expectedTitle), {message:'模型切换后校验不一致，已停止发送。'});
    if (option.isConnected && visible(option)) await closePanel(option);
  }
  async function modelMatches(model) {
    if (normalized(query(S.modelName)?.textContent)) return currentModelMatches(model);
    await openModels();
    const option = await findModelOption(model);
    const matches = currentModelMatches(model,modelTitle(option));
    await closePanel(option);
    return matches;
  }
  async function openSystem() {
    if (!visible(query(S.systemText))) {
      const button = await until(() => query(S.systemButton),{message:'找不到 System instructions 按钮。'});
      button.click();
    }
    return until(() => visible(query(S.systemText)) && query(S.systemText), {message:'无法打开系统指令编辑面板。'});
  }
  async function chooseInstruction(name) {
    const select = query(S.systemSelect);
    if (!select) throw new Error('系统指令预设选择器不存在。');
    if (select.getAttribute('aria-expanded') !== 'true') select.click();
    const options = await until(() => many('[role="option"]').filter(visible).length && many('[role="option"]').filter(visible));
    const option = options.find(e => name === null ? /Create new instruction|创建新指令/i.test(e.textContent) : normalized(e.textContent) === normalized(name));
    if (!option) throw new Error(`未找到系统指令预设“${name}”。请确认在本浏览器中已经保存。`);
    option.click();
    await until(() => select.getAttribute('aria-expanded') !== 'true');
  }
  async function setSystem(system) {
    let textarea = await openSystem();
    if (system.mode === 'preset') {
      await chooseInstruction(system.preset);
      await until(() => normalized(query(S.systemSelect)?.textContent) === normalized(system.preset),{message:'系统指令预设未成功选中。'});
      textarea = query(S.systemText);
      if (!textarea.value.trim()) throw new Error('选中的系统指令预设内容为空。');
    } else {
      // Select a fresh instruction first so custom text never overwrites a named preset.
      if (query(S.systemSelect)) await chooseInstruction(null);
      textarea = query(S.systemText);
      const value = system.mode === 'none' ? '' : system.text;
      setValue(textarea,value);
      await until(() => query(S.systemText)?.value === value,{message:'系统指令写入后校验失败。'});
      await pause(500);
    }
    const value = textarea.value;
    await closePanel(textarea);
    return value;
  }
  const optionalTools = Object.freeze([
    {name:'Code execution',remove:'button[aria-label="Remove Code execution"]',switch:'button[role="switch"][aria-label="Code execution"]'},
    {name:'Grounding with Google Search',remove:'button[aria-label="Remove Grounding with Google Search"]',switch:'button[role="switch"][aria-label="Grounding with Google Search"]'},
    {name:'URL context',remove:'button[aria-label="Remove URL context"]',switch:'button[role="switch"][aria-label="Browse the url context"],button[role="switch"][aria-label="URL context"]'},
  ]);
  function toolEnabled(tool) {
    if(query(tool.remove)) return true;
    return many(tool.switch).some(button=>button.getAttribute('aria-checked')==='true' || button.classList.contains('mdc-switch--checked'));
  }
  async function disableOptionalTools() {
    for(const tool of optionalTools) {
      if(!toolEnabled(tool)) continue;
      const remove=query(tool.remove),toggle=many(tool.switch).find(toolEnabledButton=>toolEnabledButton.getAttribute('aria-checked')==='true' || toolEnabledButton.classList.contains('mdc-switch--checked'));
      const control=enabled(remove)?remove:enabled(toggle)?toggle:null;
      if(!control) throw new Error(`${tool.name} 当前开启，但网页不允许关闭。请在执行页面手动关闭后继续。`);
      control.click();
      await until(()=>!toolEnabled(tool),{timeout:10000,message:`无法确认 ${tool.name} 已关闭。请在执行页面手动关闭后继续。`});
    }
    const remaining=optionalTools.filter(toolEnabled).map(tool=>tool.name);
    if(remaining.length) throw new Error(`以下工具仍处于开启状态：${remaining.join('、')}。已停止发送。`);
    return optionalTools.map(tool=>tool.name);
  }
  async function discover() {
    await until(() => query(S.prompt),{timeout:30000,message:'未找到 AI Studio 输入框，请先登录并进入 Playground。'});
    await openModels();
    const options = many(S.modelOptions);
    const models = options.map(e => ({id:modelId(e),name:modelTitle(e),disabled:!enabled(e)}));
    const currentModel = models.find(item => currentModelMatches(item.id,item.name))?.id || '';
    await closePanel(options[0]);
    const textarea = await openSystem();
    const select = query(S.systemSelect);
    let presets=[];
    if (select) {
      select.click();
      await until(() => many('[role="option"]').some(visible));
      presets=many('[role="option"]').filter(visible).map(e=>normalized(e.textContent)).filter(t=>!/Create new instruction|创建新指令/i.test(t));
      select.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));
      if(select.getAttribute('aria-expanded')==='true') {
        const selected=many('[role="option"]').find(e=>e.getAttribute('aria-selected')==='true');
        selected?.click();
      }
    }
    await closePanel(textarea);
    return { models, presets, currentModel, prompt: !!query(S.prompt), upload: !!query(S.upload), url:location.href };
  }
  function topLevelCount(elements) {
    const unique=[...new Set(elements)].filter(e=>e?.isConnected);
    return unique.filter(e=>!unique.some(parent=>parent!==e&&parent.contains(e))).length;
  }
  function attachmentSignals() {
    const box = query('ms-prompt-box');
    if(!box) return {count:0,promptMedia:0,readyPromptMedia:0,specific:0,promptChunks:0,media:0,containers:0,removers:0,selectedFiles:0};
    // The speech-to-text button contains a canvas; it is not an attachment.
    const mediaSelector='img,video,audio';
    const promptMediaNodes=many('ms-prompt-media',box).filter(visible);
    const promptMedia=topLevelCount(promptMediaNodes);
    const readyPromptMedia=promptMediaNodes.filter(item=>
      !!query('[data-test-id="prompt-media-container"]',item)&&
      !!query('[data-test-id="token-count"]',item)&&
      !!query('button[aria-label="Remove media"]',item)).length;
    const specific=topLevelCount(many('ms-image-chunk,ms-media-chunk,ms-file-chunk,ms-attachment-chunk',box));
    const promptChunks=many('ms-prompt-chunk',box).filter(e=>query(`${mediaSelector},.display-media-container,[class*="preview" i]`,e)).length;
    const media=many(mediaSelector,box).filter(visible).length;
    const containerNodes=many('.display-media-container,[class*="attachment-preview" i],[class*="media-preview" i],[class*="image-preview" i],[class*="file-chip" i],[class*="attachment-chip" i],[data-test-id*="attachment" i],[data-test-id*="upload-preview" i],[data-test-id*="media-preview" i]',box).filter(visible);
    const containers=topLevelCount(containerNodes);
    const removers=many('button[aria-label]',box).filter(button=>/remove|delete|移除|删除/i.test(button.getAttribute('aria-label')||'')&&/image|file|attachment|media|图片|文件|附件/i.test(button.getAttribute('aria-label')||'')&&visible(button)).length;
    const selectedFiles=query(S.upload)?.files?.length||0;
    return {count:Math.max(promptMedia,specific,promptChunks,media,containers,removers),promptMedia,readyPromptMedia,specific,promptChunks,media,containers,removers,selectedFiles};
  }
  function attachmentCount() { return attachmentSignals().count; }
  function uploadBusy() {
    const box=query('ms-prompt-box');
    if(!box) return false;
    return many('[role="progressbar"],mat-progress-spinner,mat-spinner,mat-progress-bar,[aria-busy="true"],[class~="uploading"],[class*="upload-progress" i],[data-test-id*="upload-progress" i]',box).some(visible);
  }
  async function confirmAttachments(expected,report) {
    let readySince=0,lastState='';
    await until(async() => {
      const errors=errorMessages();if(errors.length) throw new Error(errors.join('\n'));
      const signals=attachmentSignals(),busy=uploadBusy();
      if(signals.count>expected) throw new Error(`页面出现 ${signals.count} 个图片预览，但本轮只有 ${expected} 张图片。已暂停，防止重复发送附件。`);
      const readyCount=signals.promptMedia?signals.readyPromptMedia:signals.count;
      const state=signals.promptMedia===expected&&signals.readyPromptMedia<expected
        ?`图片预览已显示 ${signals.promptMedia}/${expected}，等待 AI Studio 完成媒体处理（${signals.readyPromptMedia}/${expected}）`
        :signals.count===expected
        ? busy?`图片已显示 ${signals.count}/${expected}，等待上传进度结束`:`图片已显示 ${signals.count}/${expected}，正在确认稳定状态`
        :`等待图片上传：已识别 ${signals.count}/${expected} 个预览（文件控件已接收 ${signals.selectedFiles}/${expected}）`;
      if(state!==lastState){lastState=state;await report(state);}
      if(readyCount===expected&&!busy){
        if(!readySince) readySince=Date.now();
        return Date.now()-readySince>=750;
      }
      readySince=0;return false;
    },{timeout:120000,message:()=>{
      const signals=attachmentSignals(),busy=uploadBusy();
      return `无法确认全部图片已上传：识别到 ${signals.count}/${expected} 个预览，完成媒体处理 ${signals.readyPromptMedia}/${signals.promptMedia||expected}，文件控件接收 ${signals.selectedFiles}/${expected}，上传进度${busy?'仍在进行':'未显示'}。请保留当前页面并重新导出上传完成状态的 DOM。当前轮次未发送。`;
    }});
  }
  async function fillTurn(turn, readAsset, report) {
    const prompt = await until(() => query(S.prompt));
    if(prompt.value.trim() && prompt.value !== turn.text) throw new Error('输入框中有其他草稿，请先移走草稿再继续。');
    const existingAttachments=attachmentCount();
    if(existingAttachments && existingAttachments!==turn.attachments.length) throw new Error(`输入框中已有 ${existingAttachments} 个附件，但本轮需要 ${turn.attachments.length} 个。请移除现有附件后继续。`);
    if(existingAttachments && prompt.value!==turn.text) throw new Error('输入框中已有附件，但文字草稿与当前轮次不一致。请清空输入框和附件后继续。');
    setValue(prompt,turn.text);
    if(turn.attachments.length) {
      const expected=turn.attachments.length;
      if(existingAttachments) {
        await report(`检测到页面已有 ${existingAttachments}/${expected} 张图片，沿用当前附件`);
      } else {
        const input = query(S.upload);
        if(!input) throw new Error('找不到图片上传控件。');
        const transfer = new DataTransfer();
        for(const [index,asset] of turn.attachments.entries()) {
          await report(`读取图片 ${index+1}/${expected}`);
          const wire = await readAsset(asset.id);
          const bytes = Uint8Array.from(atob(wire.base64),c=>c.charCodeAt(0));
          transfer.items.add(new File([bytes],wire.name,{type:wire.type}));
        }
        input.files=transfer.files;
        input.dispatchEvent(new Event('change',{bubbles:true}));
        await report(`等待图片上传：已识别 0/${expected} 个预览`);
      }
      await confirmAttachments(expected,report);
      await report(`图片上传已确认：${expected}/${expected}`);
      await pause(500);
    }
    if(!(idle()&&enabled(query(S.run)))) await report('内容与图片已确认，等待 Run 按钮可用');
    await until(() => idle() && enabled(query(S.run)),{timeout:20000,message:'图片上传已经确认，但 Run 仍不可用。请检查模型权限、API Key、额度或页面错误。'});
    if(query(S.prompt)?.value !== turn.text) throw new Error('页面输入内容与本轮内容不一致，已停止发送。');
  }
  globalThis.BookflowDOM={ S,query,many,visible,enabled,normalized,pause,until,setValue,runLabel,generating,idle,
    baseline,replyAfter,finalTurns,errorMessages,cleanMarkdown,setModel,modelMatches,setSystem,disableOptionalTools,discover,
    attachmentSignals,attachmentCount,uploadBusy,fillTurn };
})();
