import {newGroup,newConversation,newTurn,validateGroup} from './model.js';

export const BOOKFLOW_PACKAGE_FORMAT='aistudio-bookflow';
export const BOOKFLOW_PACKAGE_VERSION=1;
const IMAGE_TYPES=new Set(['image/png','image/jpeg','image/webp','image/gif']);
const MAX_GROUPS=30,MAX_CONVERSATIONS=30,MAX_TURNS_PER_CONVERSATION=100,MAX_TURNS_PER_GROUP=300;
const MAX_IMAGE_BYTES=20*1024*1024,MAX_TURN_IMAGE_BYTES=60*1024*1024;

function object(value,label){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${label}必须是对象。`);
  return value;
}
function string(value,label,{optional=false,max=Infinity}={}){
  if(value==null&&optional)return '';
  if(typeof value!=='string')throw new Error(`${label}必须是文字。`);
  if(value.length>max)throw new Error(`${label}超过 ${max.toLocaleString()} 个字符。`);
  return value;
}
function system(raw,label,{inherit=false}={}){
  if(raw==null&&inherit)return null;
  if(typeof raw==='string')return {mode:'custom',text:raw,preset:''};
  const value=object(raw,label),mode=string(value.mode,`${label}.mode`).trim();
  if(!['custom','preset','none'].includes(mode))throw new Error(`${label}.mode 只能是 custom、preset 或 none。`);
  const result={mode,text:'',preset:''};
  if(mode==='custom')result.text=string(value.text??'',`${label}.text`,{max:200000});
  if(mode==='preset'){
    result.preset=string(value.preset,`${label}.preset`,{max:300}).trim();
    if(!result.preset)throw new Error(`${label}选择了 preset，但没有填写预设名称。`);
  }
  return result;
}
function decodeAttachment(raw,label){
  const value=object(raw,label),name=string(value.name,label+'.name',{max:300}).trim();
  if(!name)throw new Error(`${label}缺少文件名。`);
  let type=string(value.type??'',label+'.type',{optional:true,max:100}).trim().toLowerCase();
  let encoded=value.base64;
  if(value.dataUrl!=null){
    const dataUrl=string(value.dataUrl,label+'.dataUrl');
    const match=dataUrl.match(/^data:([^;,]+);base64,([a-z\d+/=\s]+)$/i);
    if(!match)throw new Error(`${label}.dataUrl 不是有效的 Base64 图片。`);
    type=type||match[1].toLowerCase();encoded=match[2];
  }
  if(!IMAGE_TYPES.has(type))throw new Error(`${label}的图片类型不支持，请使用 PNG、JPG、WebP 或 GIF。`);
  encoded=string(encoded,label+'.base64').replace(/\s+/g,'');
  if(!encoded||encoded.length%4!==0||!/^[a-z\d+/]*={0,2}$/i.test(encoded))throw new Error(`${label}.base64 格式无效。`);
  let binary;
  try{binary=atob(encoded);}catch{throw new Error(`${label}.base64 无法解码。`);}
  if(!binary.length)throw new Error(`${label}的图片内容为空。`);
  if(binary.length>MAX_IMAGE_BYTES)throw new Error(`${label}超过 20 MB。`);
  const bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  const id=crypto.randomUUID();
  return {meta:{id,name,type,size:bytes.byteLength},asset:{id,name,type,size:bytes.byteLength,blob:new Blob([bytes],{type})}};
}

export function parseBookflowPackage(input){
  const root=object(input,'任务包');
  if(root.format!==BOOKFLOW_PACKAGE_FORMAT)throw new Error(`任务包 format 必须是“${BOOKFLOW_PACKAGE_FORMAT}”。`);
  if(root.version!==BOOKFLOW_PACKAGE_VERSION)throw new Error(`暂不支持任务包版本 ${String(root.version)}，当前只支持版本 ${BOOKFLOW_PACKAGE_VERSION}。`);
  if(!Array.isArray(root.groups)||!root.groups.length)throw new Error('任务包至少需要一个组。');
  if(root.groups.length>MAX_GROUPS)throw new Error(`一个任务包最多导入 ${MAX_GROUPS} 个组。`);
  const assets=[];
  const groups=root.groups.map((rawGroup,gi)=>{
    const source=object(rawGroup,`第 ${gi+1} 个组`),name=string(source.name,`第 ${gi+1} 个组.name`,{max:120}).trim();
    if(!name)throw new Error(`第 ${gi+1} 个组缺少名称。`);
    const group=newGroup(name);
    group.model=source.model==null?group.model:string(source.model,`${name}.model`,{max:300}).trim();
    group.system=source.system==null?group.system:system(source.system,`${name}.system`);
    group.timeoutMinutes=source.timeoutMinutes==null?group.timeoutMinutes:Number(source.timeoutMinutes);
    group.focusIntervalSeconds=source.focusIntervalSeconds==null?group.focusIntervalSeconds:Number(source.focusIntervalSeconds);
    group.exportMode=source.exportMode==null?'plain':source.exportMode;
    if(!['plain','headings'].includes(group.exportMode))throw new Error(`${name}.exportMode 只能是 plain 或 headings。`);
    if(!Array.isArray(source.conversations)||!source.conversations.length)throw new Error(`“${name}”至少需要一个对话。`);
    if(source.conversations.length>MAX_CONVERSATIONS)throw new Error(`“${name}”最多包含 ${MAX_CONVERSATIONS} 个对话。`);
    let turnCount=0;
    group.conversations=source.conversations.map((rawConversation,ci)=>{
      const value=object(rawConversation,`${name} · 对话 ${ci+1}`),conversation=newConversation(ci+1);
      conversation.title=string(value.title??`对话 ${ci+1}`,`${name} · 对话 ${ci+1}.title`,{max:300}).trim()||`对话 ${ci+1}`;
      conversation.model=value.model==null?'':string(value.model,`${conversation.title}.model`,{max:300}).trim();
      conversation.system=value.system==null?null:system(value.system,`${conversation.title}.system`,{inherit:true});
      if(!Array.isArray(value.turns)||!value.turns.length)throw new Error(`“${conversation.title}”至少需要一个轮次。`);
      if(value.turns.length>MAX_TURNS_PER_CONVERSATION)throw new Error(`“${conversation.title}”最多包含 ${MAX_TURNS_PER_CONVERSATION} 个轮次。`);
      turnCount+=value.turns.length;
      if(turnCount>MAX_TURNS_PER_GROUP)throw new Error(`“${name}”所有对话合计最多 ${MAX_TURNS_PER_GROUP} 轮。`);
      conversation.turns=value.turns.map((rawTurn,ti)=>{
        const item=object(rawTurn,`${conversation.title} · 第 ${ti+1} 轮`),turn=newTurn();
        turn.title=string(item.title??`第 ${ti+1} 轮`,`${conversation.title} · 第 ${ti+1} 轮.title`,{max:300}).trim()||`第 ${ti+1} 轮`;
        turn.text=string(item.text??'',`${conversation.title} · ${turn.title}.text`,{max:5000000});
        if(item.attachments!=null&&!Array.isArray(item.attachments))throw new Error(`${conversation.title} · ${turn.title}.attachments 必须是数组。`);
        let imageBytes=0;
        turn.attachments=(item.attachments||[]).map((attachment,ai)=>{
          const decoded=decodeAttachment(attachment,`${conversation.title} · ${turn.title} · 图片 ${ai+1}`);
          imageBytes+=decoded.meta.size;
          if(imageBytes>MAX_TURN_IMAGE_BYTES)throw new Error(`${conversation.title} · ${turn.title}的图片总计超过 60 MB。`);
          assets.push(decoded.asset);return decoded.meta;
        });
        return turn;
      });
      return conversation;
    });
    validateGroup(group);
    return group;
  });
  return {groups,assets};
}
