import test from 'node:test';
import assert from 'node:assert/strict';
import { providerBody } from '../shared/provider-body.mjs';

test('streamed provider JSON preserves binary bytes across arbitrary chunk boundaries',async()=>{
  for(const size of [1,2,3,4,49153,1048577]) {
    const bytes=Buffer.alloc(size);for(let i=0;i<size;i++)bytes[i]=i%251;
    let offset=0;
    const source=new ReadableStream({pull(c){if(offset===size){c.close();return;}const end=Math.min(offset+103,size);c.enqueue(bytes.subarray(offset,end));offset=end;}});
    const encoded=providerBody({subject:'测试'},[{id:'test',filename:'能力对比.md',size}],async()=>new Response(source));
    const body=await new Response(encoded.body).arrayBuffer();assert.equal(body.byteLength,encoded.length);
    const payload=JSON.parse(new TextDecoder().decode(body));assert.deepEqual(Buffer.from(payload.attachments[0].content,'base64'),bytes);
  }
});
test('streaming validates stored size and unavailable attachments',async()=>{
  for(const response of [new Response('abc'),new Response('a'),new Response('no',{status:404})]) {
    const encoded=providerBody({},[{id:'test',filename:'a.txt',size:2}],async()=>response);
    await assert.rejects(new Response(encoded.body).text(),/Attachment/);
  }
});
test('25 MB attachment streams in bounded chunks',async()=>{
  const size=25*1024*1024;let remaining=size;
  const encoded=providerBody({},[{id:'test',filename:'large.bin',size}],async()=>new Response(new ReadableStream({pull(c){if(!remaining){c.close();return;}const count=Math.min(remaining,65536);c.enqueue(new Uint8Array(count));remaining-=count;}})));
  const reader=encoded.body.getReader();let total=0,max=0;
  for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;max=Math.max(max,value.length);}
  assert.equal(total,encoded.length);assert.ok(max<70000);
});
