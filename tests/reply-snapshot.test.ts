import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Collection, MessageType } from 'discord.js';
import { ReplyThreads } from '../src/services/ReplyThreads';
import { RepostRegistry } from '../src/services/RepostRegistry';
import type { ButtonInteraction, ThreadChannel, APIMessageTopLevelComponent } from 'discord.js';

test('late no-thread parent response cannot discard a creation that already completed', async t => {
 const dir = mkdtempSync(join(tmpdir(), 'F2-snapshot-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const BOT='444444444444444444', GUILD='111111111111111111', CHANNEL='222222222222222222', OWNER='555555555555555555';
 const id=String(BigInt(Date.now()-1420070400000)<<22n), sourceId=String(BigInt(id)+1n);
 let start!:()=>void, releaseCreate!:()=>void, captured!:()=>void, releaseResponse!:()=>void;
 const started=new Promise<void>(r=>start=r), createGate=new Promise<void>(r=>releaseCreate=r);
 const snapshotCaptured=new Promise<void>(r=>captured=r), responseGate=new Promise<void>(r=>releaseResponse=r);
 let threadExists=false, parentDeleted=false, threadFetches=0, enabled=true;
 const pages=new Collection<string, { id: string; author: { id: string }; type: MessageType; components: APIMessageTopLevelComponent[]; createdTimestamp: number; delete(): Promise<void> }>();
 const thread={id,guildId:GUILD,parentId:CHANNEL,ownerId:BOT,archived:false,locked:false,name:'Replies to @foo',messageCount:0,url:'https://discord.com/thread',
  send:async(payload: { components: APIMessageTopLevelComponent[] })=>{pages.set('page',{id:'page',author:{id:BOT},type:MessageType.Default,components:payload.components,createdTimestamp:Date.now(),delete:async()=>{pages.delete('page')}});thread.messageCount++},
  messages:{fetch:async()=>new Collection(pages)},permissionsFor:()=>({has:()=>false}),bulkDelete:async()=>{},
  setName:async(name:string)=>{thread.name=name},setArchived:async(value:boolean)=>{thread.archived=value}};
 const parent={id,guildId:GUILD,channelId:CHANNEL,author:{id:BOT},hasThread:false,
  channel:{type:0,permissionsFor:()=>({has:()=>true})},fetch:async()=>parent,
  startThread:async()=>{start();await createGate;threadExists=true;parent.hasThread=true;return thread as unknown as ThreadChannel},
  delete:async()=>{parentDeleted=true}};
 let manager: ReplyThreads;
 const registry=new RepostRegistry({path:join(dir,'records.json'),botUserId:BOT,canRetry:async()=>true,
  fetchMessage:async()=>{const snapshot={...parent,hasThread:threadExists};captured();await responseGate;return snapshot},
  afterReplacementRemoved:async (record, parent)=>{ if(manager.needsCleanup(GUILD, record.replacementId, parent)) await manager.cleanup({guildId:GUILD,channelId:CHANNEL,threadId:record.replacementId}); }});
 const record={guildId:GUILD,channelId:CHANNEL,sourceId,replacementId:id,authorId:OWNER,mode:'replace' as const};
 assert.equal(await registry.remember(record),true);
 manager=new ReplyThreads({botUserId:()=>BOT,enabled:()=>enabled,tracked:()=>registry.isActive(id),
  lookup:async()=>({N:1,countTime:Date.now(),r:1,m:0,source:'X',orderLabel:'most liked first',replies:[{name:'foo',handle:'foo',profileUrl:'https://x.com/foo',url:'https://x.com/foo/status/21',text:'reply',likes:1,timestamp:1700000000,hasMedia:false}]}),
  fetchThread:async()=>{threadFetches++;return threadExists?thread as unknown as ThreadChannel:null}});
 const input={customId:'linky:replies:x:20:foo',message:parent,guildId:GUILD,guild:{members:{me:{id:BOT}}},user:{id:OWNER},deferred:false,
  deferReply:async()=>{input.deferred=true},reply:async()=>{},editReply:async()=>{}};
 const click=manager.handle(input as unknown as ButtonInteraction);await started;
 const removal=registry.remove(record);await snapshotCaptured;
 releaseCreate();await click;enabled=false;
 releaseResponse();assert.equal(await removal,true);
 assert.equal(parentDeleted,true);
 assert.equal(pages.size,0,'completed creation remains known even when parent metadata was captured earlier');
 assert.equal(threadFetches,1);
});
