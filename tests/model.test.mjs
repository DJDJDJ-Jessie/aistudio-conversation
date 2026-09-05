import test from 'node:test';
import assert from 'node:assert/strict';
import {newGroup,newTurn,newConversation,counts,nextPending,settingsFor,validateGroup,assembleMarkdown,filename,duplicateGroup} from '../extension/lib/model.js';
test('3/3/4 scheduler respects conversation and round order and resumes first uncommitted result',()=>{
  const g=newGroup('测试');g.conversations=[3,3,4].map((n,i)=>{const c=newConversation(i+1);c.turns=Array.from({length:n},()=>newTurn());return c;});
  const visited=[];
  for(let n=0;n<10;n++){const cursor=nextPending(g);visited.push([cursor.ci,cursor.ti]);g.conversations[cursor.ci].turns[cursor.ti].result={markdown:String(n)};}
  assert.deepEqual(visited,[[0,0],[0,1],[0,2],[1,0],[1,1],[1,2],[2,0],[2,1],[2,2],[2,3]]);
  assert.equal(nextPending(g),null);assert.equal(counts(g).complete,10);
  assert.equal(assembleMarkdown(g),'0\n\n1\n\n2\n\n3\n\n4\n\n5\n\n6\n\n7\n\n8\n\n9\n');
});
test('validation catches empty rounds but allows image-only rounds; overrides inherit correctly',()=>{
  const g=newGroup('图片');assert.equal(g.focusIntervalSeconds,10);assert.throws(()=>validateGroup(g),/没有文字或图片/);
  g.conversations[0].turns[0].attachments=[{id:'a'}];assert.doesNotThrow(()=>validateGroup(g));
  g.system={mode:'preset',preset:'经济类拆书'};assert.equal(settingsFor(g,g.conversations[0]).system.preset,'经济类拆书');
  g.conversations[0].system={mode:'none'};g.conversations[0].model='alternative';
  assert.equal(settingsFor(g,g.conversations[0]).system.mode,'none');assert.equal(settingsFor(g,g.conversations[0]).model,'alternative');
  g.timeoutMinutes=0;assert.throws(()=>validateGroup(g),/等待上限/);
  g.timeoutMinutes=20;g.focusIntervalSeconds=1;assert.throws(()=>validateGroup(g),/置顶间隔/);
});
test('partial export omits pending rounds, original indentation preserved and optional headings separate',()=>{
  const g=newGroup('整书');g.conversations[0].turns.push(newTurn('第二轮'));
  g.conversations[0].turns[0].result={markdown:'- 主标题\n    - 子标题'};
  assert.equal(assembleMarkdown(g),'- 主标题\n    - 子标题\n');
  g.exportMode='headings';assert.ok(assembleMarkdown(g).startsWith('# 整书\n\n## 对话 1'));assert.ok(!assembleMarkdown(g).includes('第二轮'));
});
test('copy retains image references, resets every result and execution identity',()=>{
  const source=newGroup('书');source.run={status:'completed'};source.conversations[0].turns[0].result={markdown:'result'};source.conversations[0].turns[0].attachments=[{id:'shared'}];
  const copy=duplicateGroup(source);assert.notEqual(copy.id,source.id);assert.notEqual(copy.conversations[0].id,source.conversations[0].id);
  assert.equal(copy.run,null);assert.equal(copy.conversations[0].turns[0].result,null);assert.equal(copy.conversations[0].turns[0].attachments[0].id,'shared');
  assert.equal(source.conversations[0].turns[0].result.markdown,'result');
});
test('filenames preserve Chinese group names and normalize Windows-invalid characters',()=>{
  assert.equal(filename('周期 · 全书拆解'),'周期 · 全书拆解.md');assert.equal(filename('a/b:c?'),'a_b_c_.md');assert.equal(filename('CON'),'_CON.md');
  assert.equal(filename('....'),'拆书结果.md');assert.equal(filename(''),'拆书结果.md');
});
