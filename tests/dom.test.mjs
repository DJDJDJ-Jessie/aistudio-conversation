import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const snapshotDir=new URL('../reference-dom/pages/',import.meta.url);
const haveSnapshots=existsSync(snapshotDir)&&readdirSync(snapshotDir).filter(file=>file.endsWith('.html')).length>=6;
const sources=['vendor/turndown.js','vendor/turndown-plugin-gfm.js','content/dom.js'].map(p=>readFileSync(new URL('../extension/'+p,import.meta.url),'utf8'));
function load(html){
  const dom=new JSDOM(html,{url:'https://aistudio.google.com/app/prompts/new_chat',runScripts:'outside-only'});
  sources.forEach(s=>dom.window.eval(s));return {dom,D:dom.window.BookflowDOM,doc:dom.window.document};
}
function snapshot(n){return readFileSync(new URL(readdirSync(snapshotDir).find(f=>f.startsWith(n)&&f.endsWith('.html')),snapshotDir),'utf8');}
test('all six provided snapshots match prompt, run, model and upload selectors',{skip:!haveSnapshots},()=>{
  for(let n=1;n<=6;n++){
    const {dom,D,doc}=load(snapshot(String(n).padStart(2,'0')));
    for(const selector of [D.S.prompt,D.S.upload,D.S.run,D.S.model,D.S.modelName,D.S.systemButton])
      assert.ok(doc.querySelector(selector),`page ${n}: ${selector}`);
    dom.window.close();
  }
});
test('model identities and preset selectors are extracted from actual DOM',{skip:!haveSnapshots},()=>{
  let {dom,D,doc}=load(snapshot('02'));
  assert.ok(doc.querySelectorAll(D.S.modelOptions).length>=20);
  assert.ok(doc.getElementById('model-carousel-row-models/gemini-2.5-pro'));dom.window.close();
  ({dom,D,doc}=load(snapshot('03')));
  assert.ok(doc.querySelector(D.S.systemText));assert.ok(doc.querySelector(D.S.systemSelect));
  assert.ok([...doc.querySelectorAll('[role=option]')].some(e=>e.textContent.includes('经济类拆书')));dom.window.close();
});
test('completed real page has disabled Run: completion must use label and final footer',{skip:!haveSnapshots},()=>{
  const {dom,D,doc}=load(snapshot('06'));
  assert.equal(D.enabled(doc.querySelector(D.S.run)),false);
  assert.equal(D.idle(),true);assert.equal(D.generating(),false);
  assert.equal(D.finalTurns().length,1);assert.ok(D.finalTurns()[0].querySelector(D.S.final));dom.window.close();
});
test('real Chinese reply preserves every paragraph and nested list, excludes thought and UI',{skip:!haveSnapshots},()=>{
  const {dom,D}=load(snapshot('06'));
  const final=D.finalTurns()[0],md=D.cleanMarkdown(final);
  assert.match(md,/^-\s+03 周期的规律/);
  assert.match(md,/\n {4}-\s+人类试图看透人生/);
  assert.ok(md.includes('拥有这种理解周期的巨大知识优势'));
  assert.ok(!/Analyzing the Core Task|Thoughts|thumb_up|more_vert|44\.8s/.test(md));
  for(const p of final.querySelectorAll('ms-text-chunk p'))assert.ok(md.includes(p.textContent.trim()),p.textContent.slice(0,70));
  assert.equal(md.match(/03 周期的规律/g).length,1);dom.window.close();
});
test('same text across two rounds is tracked by new user and reply IDs, never by content equality',()=>{
  const {dom,D,doc}=load('<ms-chat-turn class="text-chunk-host" id="u1"><div data-turn-role="User"><ms-prompt-chunk>same request</ms-prompt-chunk></div></ms-chat-turn><ms-chat-turn id="r1"><div data-turn-role="Model"><ms-text-chunk><p>same</p></ms-text-chunk></div></ms-chat-turn>');
  const checkpoint=D.baseline();
  doc.body.insertAdjacentHTML('beforeend','<ms-chat-turn class="text-chunk-host" id="u2"><div data-turn-role="User"><ms-prompt-chunk>same request</ms-prompt-chunk></div></ms-chat-turn><ms-chat-turn class="thought-activity-host" id="thought"><div data-turn-role="Model"><ms-thought-chunk>private</ms-thought-chunk></div></ms-chat-turn><ms-chat-turn id="r2"><div data-turn-role="Model"><ms-text-chunk><p>same</p></ms-text-chunk></div></ms-chat-turn>');
  const reply=D.replyAfter(checkpoint);assert.equal(reply.userId,'u2');assert.equal(reply.turns.length,1);assert.equal(reply.turns[0].id,'r2');
  doc.body.insertAdjacentHTML('beforeend','<ms-chat-turn class="text-chunk-host" id="u3"><div data-turn-role="User"><ms-prompt-chunk>manual message</ms-prompt-chunk></div></ms-chat-turn>');
  assert.throws(()=>D.replyAfter(checkpoint),/本轮之外/);dom.window.close();
});

test('AI Studio empty User composer is ignored while the submitted turn is generating',()=>{
  const {dom,D,doc}=load('');
  const checkpoint=D.baseline();
  doc.body.innerHTML='<ms-chat-turn id="empty-composer"><div data-turn-role="User"></div></ms-chat-turn><ms-chat-turn class="text-chunk-host" id="submitted"><div data-turn-role="User"><ms-prompt-chunk>chapter text</ms-prompt-chunk></div></ms-chat-turn><ms-chat-turn class="text-chunk-host thought-activity-host" id="thought"><div data-turn-role="Model"><ms-thought-chunk>thinking</ms-thought-chunk></div></ms-chat-turn>';
  assert.equal(D.replyAfter(checkpoint),null,'thinking state must keep waiting instead of treating the composer as a second message');
  doc.body.insertAdjacentHTML('beforeend','<ms-chat-turn class="text-chunk-host" id="final"><div data-turn-role="Model"><ms-text-chunk><p>answer</p></ms-text-chunk></div></ms-chat-turn>');
  const reply=D.replyAfter(checkpoint);
  assert.equal(reply.userId,'submitted');
  assert.equal(reply.turns.map(turn=>turn.id).join(','),'final');
  dom.window.close();
});

test('virtualized submitted User turn remains identifiable after its body is unloaded',()=>{
  const {dom,D,doc}=load('');
  const checkpoint=D.baseline();
  doc.body.innerHTML='<ms-chat-turn id="empty-composer"><div data-turn-role="User"></div></ms-chat-turn><ms-chat-turn class="text-chunk-host" id="submitted"><div data-turn-role="User"></div></ms-chat-turn><ms-chat-turn class="text-chunk-host" id="final"><div data-turn-role="Model"><ms-text-chunk><p>answer</p></ms-text-chunk></div></ms-chat-turn>';
  const reply=D.replyAfter(checkpoint);
  assert.equal(reply.userId,'submitted');
  assert.equal(reply.turns[0].id,'final');
  dom.window.close();
});
test('code, tables and links convert without clipboard access or active HTML',()=>{
  const {dom,D,doc}=load(`<ms-chat-turn><div data-turn-role="Model"><ms-text-chunk><h2>标题</h2><ms-code-block data-test-language="js"><button>Copy</button><pre><code>const x = '&lt;unsafe&gt;';\nconsole.log(x);</code></pre></ms-code-block><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table><a href="javascript:alert(1)">bad link</a><a href="https://example.org">safe</a></ms-text-chunk></div></ms-chat-turn>`);
  const md=D.cleanMarkdown(doc.querySelector('ms-chat-turn'));
  assert.match(md,/## 标题/);assert.match(md,/```js\nconst x/);assert.ok(md.includes('console.log(x);'));
  assert.ok(md.includes('| A | B |'));assert.ok(!md.includes('javascript:'));assert.ok(!md.includes('Copy'));assert.ok(md.includes('[safe](https://example.org)'));dom.window.close();
});

test('the three optional AI Studio tools are forced off and verified',async()=>{
  const {dom,D,doc}=load(`<div id="tools">
    <button role="switch" aria-label="Code execution" aria-checked="true" class="mdc-switch--checked"></button>
    <button role="switch" aria-label="Grounding with Google Search" aria-checked="true" class="mdc-switch--checked"></button>
    <button role="switch" aria-label="Browse the url context" aria-checked="true" class="mdc-switch--checked"></button>
  </div>`);
  for(const button of doc.querySelectorAll('[role=switch]'))button.addEventListener('click',()=>{button.setAttribute('aria-checked','false');button.classList.remove('mdc-switch--checked');});
  await D.disableOptionalTools();
  assert.deepEqual([...doc.querySelectorAll('[role=switch]')].map(button=>button.getAttribute('aria-checked')),['false','false','false']);
  dom.window.close();
});

test('the September 4 model trigger is supported and the exact model is verified by its carousel row',async()=>{
  const {dom,D,doc}=load(`<style>*{display:block}</style>
    <ms-model-selector>
      <div class="model-selector-card">
        <button class="model-selector-trigger" aria-label="Select primary model"><span class="title">Antigravity Agent Preview</span><span data-test-id="model-description">Agent</span></button>
        <button data-test-id="agent-model-badge" aria-label="Select Antigravity agent harness model">Gemini 3.8 Flash</button>
      </div>
    </ms-model-selector>`);
  Object.defineProperty(dom.window.Element.prototype,'getClientRects',{value(){return this.isConnected?[{}]:[];}});
  const trigger=doc.querySelector('.model-selector-trigger');
  trigger.addEventListener('click',()=>{
    const panel=doc.createElement('div');panel.className='cdk-overlay-pane';
    panel.innerHTML='<button aria-label="Close panel">close</button><input placeholder="Search for a model or agent"><button id="model-carousel-row-models/gemini-3.8-flash"><span class="model-title-text">Gemini 3.8 Flash</span></button><button id="model-carousel-row-models/gemini-2.5-pro"><span class="model-title-text">Gemini 2.5 Pro</span></button>';
    panel.querySelector('[aria-label="Close panel"]').addEventListener('click',()=>panel.remove());
    for(const option of panel.querySelectorAll('[id^="model-carousel-row-models/"]')) option.addEventListener('click',()=>{
      trigger.querySelector('.title').textContent=option.querySelector('.model-title-text').textContent;
      panel.remove();
    });
    doc.body.append(panel);
  });
  assert.ok(doc.querySelector(D.S.model));
  assert.equal(doc.querySelector(D.S.modelName),null);
  await D.setModel('gemini-2.5-pro');
  assert.equal(doc.querySelector(D.S.modelTitle).textContent,'Gemini 2.5 Pro');
  assert.equal(await D.modelMatches('gemini-2.5-pro'),true);
  assert.equal(await D.modelMatches('gemini-3.8-flash'),false);
  dom.window.close();
});

test('uploaded images are recognized outside legacy ms-image-chunk and upload progress is independent from Run',()=>{
  const {dom,D,doc}=load(`<style>*{display:block}</style><ms-prompt-box>
    <input data-test-upload-file-input type="file">
    <div class="media-preview"><img src="blob:test"></div>
    <div role="progressbar"></div>
    <ms-run-button><button aria-disabled="true"><span class="run-button-label">Run</span></button></ms-run-button>
  </ms-prompt-box>`);
  Object.defineProperty(dom.window.Element.prototype,'getClientRects',{value(){return this.isConnected?[{}]:[];}});
  assert.equal(D.attachmentCount(),1);
  assert.equal(D.uploadBusy(),true);
  doc.querySelector('[role=progressbar]').remove();
  assert.equal(D.uploadBusy(),false);
  assert.equal(D.enabled(doc.querySelector(D.S.run)),false,'Run availability is a later, separate check');
  dom.window.close();
});

test('3.1.zip upload completion uses prompt media, token count and the Remove media control',()=>{
  const {dom,D,doc}=load(`<style>*{display:block}</style><ms-prompt-box>
    <textarea aria-label="Enter a prompt">章节</textarea>
    <ms-prompt-media><div data-test-id="prompt-media-container"><ms-prompt-image><img class="loaded-image" alt="image.png" src="data:image/png;base64,AA=="></ms-prompt-image><span class="name">image.png</span><ms-token-status><span data-test-id="token-count">259 tokens</span></ms-token-status><button aria-label="Remove media" aria-disabled="false">close</button></div></ms-prompt-media>
    <input data-test-upload-file-input type="file">
    <button aria-label="Speech to text"><canvas></canvas></button>
    <ms-run-button><button type="submit" aria-disabled="false"><span class="run-button-label">Run</span></button></ms-run-button>
  </ms-prompt-box>`);
  Object.defineProperty(dom.window.Element.prototype,'getClientRects',{value(){return this.isConnected?[{}]:[];}});
  const signals=D.attachmentSignals();
  assert.equal(signals.promptMedia,1);
  assert.equal(signals.readyPromptMedia,1);
  assert.equal(signals.count,1);
  assert.equal(D.uploadBusy(),false);
  assert.equal(D.idle(),true);
  assert.equal(D.enabled(doc.querySelector(D.S.run)),true);
  dom.window.close();
});

test('an unsent matching draft can reuse an already uploaded image after content-script reload',async()=>{
  const {dom,D}=load(`<style>*{display:block}</style><ms-prompt-box>
    <textarea aria-label="Enter a prompt">同一轮内容</textarea>
    <input data-test-upload-file-input type="file">
    <div class="media-preview"><img src="blob:test"></div>
    <ms-run-button><button><span class="run-button-label">Run</span></button></ms-run-button>
  </ms-prompt-box>`);
  Object.defineProperty(dom.window.Element.prototype,'getClientRects',{value(){return this.isConnected?[{}]:[];}});
  let assetReads=0;const messages=[];
  await D.fillTurn({text:'同一轮内容',attachments:[{id:'image-1'}]},async()=>{assetReads++;throw new Error('should not reread');},async message=>messages.push(message));
  assert.equal(assetReads,0);
  assert.ok(messages.some(message=>message.includes('沿用当前附件')));
  assert.ok(messages.some(message=>message.includes('图片上传已确认')));
  dom.window.close();
});
