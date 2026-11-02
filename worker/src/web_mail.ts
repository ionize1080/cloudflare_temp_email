import { Hono } from 'hono';
import { providerBody } from '../../shared/provider-body.mjs';
import { Jwt } from 'hono/utils/jwt';
import { MAX_ATTACHMENTS, validateAttachment, validateCompose } from '../../shared/compose.mjs';
import { reserveWeb, failWeb, finishWeb } from '../../shared/web-submissions.mjs';
import { passwordDigest } from '../../shared/passwords.mjs';
import { getJsonSetting } from './utils';
import { CONSTANTS } from './constants';

export const webMailApi = new Hono<HonoCustomType>();
export const storageFetch = (env: Bindings, path: string, init: RequestInit = {}) => fetch(`${env.ATTACHMENT_ORIGIN}/mail-storage/${path}`, {
    ...init, headers: { 'User-Agent':'IONACS-Mail-Storage/1.0', ...init.headers, Authorization: `Bearer ${env.ATTACHMENT_SECRET}` }, signal: AbortSignal.timeout(60000), redirect: 'manual',
});
webMailApi.post('/api/compose/attachments', async c => {
    const { address_id, address } = c.get('jwtPayload');
    let filename: string;
    const size = Number(c.req.header('content-length'));
    try { filename = decodeURIComponent(c.req.header('x-filename') || ''); validateAttachment(filename, size); }
    catch { return c.text('附件名称不支持，或附件超过 25 MB', 400); }
    if (!await c.env.DB.prepare('SELECT 1 FROM address_sender WHERE address=? AND enabled=1 AND balance>0').bind(address).first()) return c.text('请先申请发件权限', 403);
    const id = crypto.randomUUID(), created_at = Math.floor(Date.now()/1000);
    try { await c.env.DB.prepare('INSERT INTO mail_attachments(id,address_id,filename,content_type,size,created_at,expires_at) VALUES(?,?,?,?,?,?,?)')
        .bind(id,address_id,filename,'application/octet-stream',size,created_at,created_at+7*86400).run(); }
    catch { return c.text('附件存储配额不足（每邮箱 500 MB，最多 40 个待发送附件）', 413); }
    try {
        const response = await storageFetch(c.env, id, { method:'PUT', headers:{'Content-Length':String(size),'Content-Type':'application/octet-stream'}, body:c.req.raw.body });
        if (!response.ok) throw new Error('Storage failed');
        await response.body?.cancel();
        await c.env.DB.prepare('UPDATE mail_attachments SET ready=1 WHERE id=?').bind(id).run();
        return c.json({ id, filename, size, expires_at: created_at+7*86400 });
    } catch {
        // Leave the reservation for scheduled cleanup if remote completion was uncertain.
        return c.text('附件上传失败，请稍后重试', 503);
    }
});
webMailApi.get('/api/compose/attachments/:id', async c => {
    const { address_id } = c.get('jwtPayload');
    const row = await c.env.DB.prepare('SELECT * FROM mail_attachments WHERE id=? AND address_id=? AND ready=1 AND (expires_at IS NULL OR expires_at>unixepoch())').bind(c.req.param('id'),address_id).first<{id:string,filename:string}>();
    if (!row) return c.text('附件不存在或已过期', 404);
    const response = await storageFetch(c.env,row.id);
    if (!response.ok) return c.text('附件暂不可用', 503);
    return new Response(response.body, { headers: {'Content-Type':'application/octet-stream', 'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`} });
});
webMailApi.delete('/api/compose/attachments/:id', async c => {
    const { address_id } = c.get('jwtPayload');
    const row = await c.env.DB.prepare('SELECT id FROM mail_attachments WHERE id=? AND address_id=? AND expires_at IS NOT NULL').bind(c.req.param('id'),address_id).first<{id:string}>();
    if (row) {
        const response = await storageFetch(c.env,row.id,{method:'DELETE'});
        if (!response.ok && response.status!==404) return c.text('删除失败，请重试',503);
        await c.env.DB.prepare('DELETE FROM mail_attachments WHERE id=? AND address_id=? AND expires_at IS NOT NULL').bind(row.id,address_id).run();
    }
    return c.json({success:true});
});
// Short-lived, attachment-only capability for the email provider. It cannot grant mailbox access.
webMailApi.get('/open_api/outgoing_attachment/:id', async c => {
    try {
        const payload = await Jwt.verify(c.req.query('token') || '', c.env.JWT_SECRET,'HS256');
        if (payload.purpose !== 'outgoing-attachment' || payload.id !== c.req.param('id') || !payload.exp) return c.text('Forbidden',403);
        const row = await c.env.DB.prepare('SELECT id FROM mail_attachments WHERE id=? AND ready=1').bind(payload.id).first();
        if (!row) return c.text('Not found',404);
        const response = await storageFetch(c.env,String(payload.id));
        return new Response(response.body,{status:response.status,headers:{'Content-Type':'application/octet-stream','Content-Disposition':'attachment'}});
    } catch { return c.text('Forbidden',403); }
});
webMailApi.post('/api/send_mail', async c => {
    const identity = c.get('jwtPayload');
    let row;
    try {
        const input = await c.req.json(), validated = validateCompose(input);
        const blocked = await getJsonSetting<string[]>(c,CONSTANTS.SEND_BLOCK_LIST_KEY) || [];
        if (validated.all.some((r: string) => blocked.some(b => r.includes(b)))) return c.text('收件人被发送规则阻止',403);
        const attachments = [];
        for (const id of validated.attachments) {
            const a = await c.env.DB.prepare('SELECT id,filename,size FROM mail_attachments WHERE id=? AND address_id=? AND ready=1 AND (expires_at IS NULL OR expires_at>unixepoch())').bind(id,identity.address_id).first<{id:string,filename:string,size:number}>();
            if (!a) return c.text('附件不存在、已过期或无权限',400);
            attachments.push(a);
        }
        if (attachments.reduce((n,a)=>n+a.size,0)>MAX_ATTACHMENTS) return c.text('每封邮件附件合计不能超过 25 MB',413);
        const mailDomain=identity.address.split('@')[1];
        const token=c.env[`RESEND_TOKEN_${mailDomain.replace(/\./g,'_').toUpperCase()}`] || c.env.RESEND_TOKEN;
        if (!token) return c.text('发件服务尚未配置',503);
        const archive={version:'v2',to_mail:validated.to.join(', '),cc:validated.cc,bcc:validated.bcc,subject:input.subject,content:input.content,is_html:!!input.is_html,attachments};
        const digest=await passwordDigest(JSON.stringify(archive));
        const reserved=await reserveWeb(c.env.DB,identity,input.send_id,digest,validated.all.length);
        if (reserved.duplicate) return c.json({status:'ok',duplicate:true});
        row=reserved.row;
        const payload={from:identity.address,to:validated.to,cc:validated.cc,bcc:validated.bcc,subject:input.subject||'（无主题）',...(input.is_html?{html:input.content}:{text:input.content})};
        const encoded=providerBody(payload,attachments,(id: string)=>storageFetch(c.env,id));
        const fixed=new FixedLengthStream(encoded.length);
        const pipeline=encoded.body.pipeTo(fixed.writable);
        // Observe the pipeline immediately; fetch can reject before the producer finishes.
        pipeline.catch(()=>{});
        let response;
        try {
            response=await fetch('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(55000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':`web/${row.id}`},body:fixed.readable});
            await pipeline;
        }
        catch { await failWeb(c.env.DB,row,false); return c.text('投递结果暂未确认，请保留原草稿并重试，不会重复扣减额度',503); }
        if (!response.ok) {
            const definitive=response.status>=400 && response.status<500 && ![408,409,425,429].includes(response.status);
            await failWeb(c.env.DB,row,definitive);
            return c.json({error:definitive?'发件服务拒绝此邮件，额度已退回，请检查内容后重试':'发件服务暂不可用，请稍后重试',reset_send_id:definitive},definitive?400:503);
        }
        const result=await response.json<{id:string}>();
        if (!result.id) throw new Error('Uncertain result');
        await finishWeb(c.env.DB,row,identity.address,result.id,{...archive,submission_id:row.id},validated.attachments);
        return c.json({status:'accepted',submission_id:row.id});
    } catch (error) {
        if (row) return c.text('投递状态待确认，请保留原草稿后重试',503);
        return c.text(error instanceof Error && /发送|邮件|收件|正文|附件|主题|邮箱/.test(error.message)?error.message:'请求无效',400);
    }
});
webMailApi.get('/api/sendbox/:id/delivery', async c => {
    const {address,address_id}=c.get('jwtPayload');
    const sent=await c.env.DB.prepare('SELECT raw FROM sendbox WHERE id=? AND address=?').bind(c.req.param('id'),address).first<{raw:string}>();
    if (!sent) return c.text('邮件不存在',404);
    let submission;
    try { submission=JSON.parse(sent.raw).submission_id; } catch { /* legacy archive */ }
    if (!submission) return c.json({status:'unknown',message:'历史邮件暂无投递状态'});
    const row=await c.env.DB.prepare('SELECT provider_id FROM web_submissions WHERE id=? AND address_id=?').bind(submission,address_id).first<{provider_id:string}>();
    if (!row?.provider_id) return c.json({status:'unknown',message:'投递状态待确认'});
    const domain=address.split('@')[1];
    const token=c.env[`RESEND_TOKEN_${domain.replace(/\./g,'_').toUpperCase()}`] || c.env.RESEND_TOKEN;
    try {
        const response=await fetch(`https://api.resend.com/emails/${encodeURIComponent(row.provider_id)}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
        if (!response.ok) return c.json({status:'unknown',message:'暂时无法查询投递状态，请稍后刷新'});
        const data=await response.json<{last_event:string}>();
        const labels:Record<string,string>={sent:'发送服务已受理，等待投递',delivered:'收件服务器已接收',opened:'收件服务器已接收',clicked:'收件服务器已接收',failed:'投递失败，请重新编辑后发送',bounced:'收件服务器退信，请检查收件地址',suppressed:'发送服务已阻止投递',delivery_delayed:'投递延迟，发送服务将继续尝试',queued:'排队等待投递'};
        return c.json({status:data.last_event,message:labels[data.last_event]||'投递状态待确认'});
    } catch { return c.json({status:'unknown',message:'暂时无法查询投递状态，请稍后刷新'}); }
});
webMailApi.get('/admin/outbound_status/:id', async c => {
    const row = await c.env.DB.prepare('SELECT w.state,w.provider_id,a.name AS address FROM web_submissions w JOIN address a ON a.id=w.address_id WHERE w.id=?').bind(c.req.param('id')).first<{state:string,provider_id:string|null,address:string}>();
    if (!row) return c.text('发件记录不存在',404);
    if (!row.provider_id) return c.json({state:row.state,provider_id:null});
    const domain=row.address.split('@')[1];
    const token=c.env[`RESEND_TOKEN_${domain.replace(/\./g,'_').toUpperCase()}`] || c.env.RESEND_TOKEN;
    if (!token) return c.text('发件服务尚未配置',503);
    try {
        const response=await fetch(`https://api.resend.com/emails/${encodeURIComponent(row.provider_id)}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
        if (!response.ok) return c.json({state:row.state,provider_id:row.provider_id,lookup_status:response.status},502);
        const data=await response.json<{last_event?:string,created_at?:string,to?:string[],cc?:string[],bcc?:string[],message_id?:string}>();
        return c.json({state:row.state,provider_id:row.provider_id,last_event:data.last_event,created_at:data.created_at,to:data.to,cc:data.cc,bcc:data.bcc,message_id:data.message_id});
    } catch { return c.text('暂时无法查询投递状态',503); }
});
webMailApi.get('/admin/storage_health', async c => {
    try { const r=await storageFetch(c.env,'health'); await r.body?.cancel();return c.json({ok:r.ok,status:r.status}); }
    catch(error){return c.json({error:error instanceof Error?error.message:'unknown'},503);}
});
webMailApi.get('/open_api/storage_health', async c => {
    try { const r=await storageFetch(c.env,'health'); if(!r.ok) console.warn(JSON.stringify({event:'storage_probe_failed',status:r.status})); await r.body?.cancel(); return c.json({ok:r.ok},r.ok?200:503); }
    catch (error) { console.warn(JSON.stringify({event:'storage_probe_error',message:error instanceof Error?error.message:'unknown'})); return c.json({ok:false},503); }
});

export async function cleanupAttachments(env: Bindings) {
    const rows=await env.DB.prepare('SELECT id FROM mail_attachments WHERE (expires_at IS NOT NULL AND expires_at<unixepoch()) OR address_id NOT IN (SELECT id FROM address) LIMIT 100').all<{id:string}>();
    for (const row of rows.results) {
        const r=await storageFetch(env,row.id,{method:'DELETE'});
        if (r.ok || r.status===404) await env.DB.prepare('DELETE FROM mail_attachments WHERE id=?').bind(row.id).run();
        await r.body?.cancel();
    }
}
