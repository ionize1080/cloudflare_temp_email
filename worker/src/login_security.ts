import { Hono } from 'hono';
import { Jwt } from 'hono/utils/jwt';
import { verifyTurnstile } from '../../shared/turnstile.mjs';
import { validSession } from '../../shared/sessions.mjs';
import { equalSecret } from '../../shared/security.mjs';
import { getAdminPasswords } from './utils';
import { mailboxToken } from './sessions';

export const loginSecurity = new Hono<HonoCustomType>();
loginSecurity.post('/open_api/admin_login',async c=>{
    const {password,cf_token}=await c.req.json();
    if(!await verifyTurnstile(c.env,cf_token,'admin_login',c.req.header('cf-connecting-ip')))return c.text('请完成人机验证后重试',403);
    for(const candidate of getAdminPasswords(c)||[]) {
        if(await equalSecret(password,candidate)) {
            const now=Math.floor(Date.now()/1000);
            const token=await Jwt.sign({purpose:'admin-session',iat:now,exp:now+3600},c.env.JWT_SECRET+':admin:v1:'+candidate,'HS256');
            return c.json({token});
        }
    }
    return c.text('管理员密码错误',401);
});
loginSecurity.post('/open_api/credential_login',async c=>{
    const {credential,cf_token}=await c.req.json();
    if(!await verifyTurnstile(c.env,cf_token,'mailbox_login',c.req.header('cf-connecting-ip')))return c.text('请完成人机验证后重试',403);
    try {
        const payload=await Jwt.verify(credential,c.env.JWT_SECRET,'HS256');
        if(!await validSession(c.env.DB,payload,'mailbox'))return c.text('邮箱凭据已失效',401);
        return c.json({jwt:await mailboxToken(c.env,Number(payload.address_id),String(payload.address))});
    }catch{return c.text('邮箱凭据已失效',401);}
});
