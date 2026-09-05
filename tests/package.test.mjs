import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBookflowPackage,BOOKFLOW_PACKAGE_FORMAT,BOOKFLOW_PACKAGE_VERSION} from '../extension/lib/bookflow-package.js';

const packageOf=groups=>({format:BOOKFLOW_PACKAGE_FORMAT,version:BOOKFLOW_PACKAGE_VERSION,groups});
const turn=(title,text)=>({title,text});

test('task package builds multiple groups and an ordered 3/3/4 plan with fresh execution state',()=>{
  const conversations=[3,3,4].map((count,ci)=>({
    title:`对话 ${String.fromCharCode(65+ci)}`,
    ...(ci===1?{model:'gemini-3.1-pro-preview',system:{mode:'none'}}:{}),
    turns:Array.from({length:count},(_,ti)=>turn(`第 ${ci*3+ti+1} 章`,`章节原文 ${ci+1}-${ti+1}`)),
  }));
  const result=parseBookflowPackage(packageOf([
    {name:'第一本书',model:'gemini-2.5-pro',system:'按层级列表拆解。',timeoutMinutes:35,focusIntervalSeconds:17,exportMode:'headings',conversations},
    {name:'第二本书',conversations:[{title:'唯一对话',turns:[turn('导读','正文')]}]},
  ]));
  assert.equal(result.groups.length,2);
  assert.deepEqual(result.groups[0].conversations.map(c=>c.turns.length),[3,3,4]);
  assert.equal(result.groups[0].conversations[1].model,'gemini-3.1-pro-preview');
  assert.equal(result.groups[0].conversations[1].system.mode,'none');
  assert.equal(result.groups[0].system.text,'按层级列表拆解。');
  assert.equal(result.groups[0].timeoutMinutes,35);
  assert.equal(result.groups[0].focusIntervalSeconds,17);
  assert.equal(result.groups[1].focusIntervalSeconds,10);
  assert.equal(result.groups[0].exportMode,'headings');
  assert.equal(result.groups[0].run,null);
  assert.ok(result.groups.every(g=>g.conversations.every(c=>c.turns.every(t=>t.result===null))));
  const ids=result.groups.flatMap(g=>[g.id,...g.conversations.flatMap(c=>[c.id,...c.turns.map(t=>t.id)])]);
  assert.equal(new Set(ids).size,ids.length);
});

test('base64 and data URL images become local Blob assets with new IDs',async()=>{
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const result=parseBookflowPackage(packageOf([{name:'图文书',conversations:[{turns:[{
    title:'图文轮次',text:'请分析两张图',attachments:[
      {name:'a.png',type:'image/png',base64:png},
      {name:'b.png',dataUrl:`data:image/png;base64,${png}`},
    ],
  }]}]}]));
  assert.equal(result.assets.length,2);
  assert.equal(result.groups[0].conversations[0].turns[0].attachments.length,2);
  assert.ok(result.assets.every(asset=>asset.blob instanceof Blob&&asset.blob.type==='image/png'&&asset.size>0));
  assert.deepEqual(result.assets.map(a=>a.id),result.groups[0].conversations[0].turns[0].attachments.map(a=>a.id));
  assert.ok((await result.assets[0].blob.arrayBuffer()).byteLength>0);
});

test('untrusted IDs, results and runs from a package are ignored',()=>{
  const result=parseBookflowPackage(packageOf([{id:'foreign-group',name:'安全导入',run:{status:'completed'},conversations:[{
    id:'foreign-conversation',turns:[{id:'foreign-turn',text:'正文',result:{markdown:'伪造结果'}}],
  }]}]));
  const group=result.groups[0],conversation=group.conversations[0],parsedTurn=conversation.turns[0];
  assert.notEqual(group.id,'foreign-group');
  assert.notEqual(conversation.id,'foreign-conversation');
  assert.notEqual(parsedTurn.id,'foreign-turn');
  assert.equal(group.run,null);
  assert.equal(parsedTurn.result,null);
});

test('task package rejects malformed structure and unusable turns before import',()=>{
  assert.throws(()=>parseBookflowPackage({}),/format/);
  assert.throws(()=>parseBookflowPackage({format:BOOKFLOW_PACKAGE_FORMAT,version:2,groups:[]}),/版本/);
  assert.throws(()=>parseBookflowPackage(packageOf([])),/至少需要一个组/);
  assert.throws(()=>parseBookflowPackage(packageOf([{name:'空书',conversations:[{turns:[{text:''}]}]}])),/没有文字或图片/);
  assert.throws(()=>parseBookflowPackage(packageOf([{name:'坏置顶间隔',focusIntervalSeconds:1,conversations:[{turns:[{text:'正文'}]}]}])),/置顶间隔/);
  assert.throws(()=>parseBookflowPackage(packageOf([{name:'坏图',conversations:[{turns:[{attachments:[{name:'x.svg',type:'image/svg+xml',base64:'AAAA'}]}]}]}])),/图片类型不支持/);
  assert.throws(()=>parseBookflowPackage(packageOf([{name:'坏编码',conversations:[{turns:[{attachments:[{name:'x.png',type:'image/png',base64:'not base64'}]}]}]}])),/base64 格式无效/);
});
