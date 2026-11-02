import { Context } from 'hono';
import { Jwt } from 'hono/utils/jwt';
import { setCookie, deleteCookie } from 'hono/cookie';
import { consumeMailTicket, MAIL_COOKIE } from '../../shared/navigation-sso.mjs';

export async function navigationLogin(c: Context<HonoCustomType>) {
    if (c.req.header('Origin') !== 'https://mail.ionacs.com') return c.text('Forbidden origin', 403);
    const ip = c.req.header('CF-Connecting-IP') || 'unknown';
    if (!c.env.AUTH_RATE_LIMITER || !(await c.env.AUTH_RATE_LIMITER.limit({key:'navigation-mail:'+ip})).success) return c.text('登录尝试过多，请稍后重试', 429);
    const {ticket} = await c.req.json();
    try {
        const claims = await consumeMailTicket(c.env.DB,ticket);
        const value = await Jwt.sign(claims,c.env.JWT_SECRET,'HS256');
        setCookie(c,MAIL_COOKIE,value,{secure:true,httpOnly:true,sameSite:'Lax',path:'/',maxAge:claims.exp-Math.floor(Date.now()/1000)});
        return c.json({success:true,address:claims.address,expires_at:claims.exp});
    } catch { return c.text('自动登录链接已失效，请从导航页重新打开邮箱。',401); }
}
export function navigationLogout(c: Context<HonoCustomType>) {
    if(c.req.header('Origin') !== 'https://mail.ionacs.com')return c.text('Forbidden origin',403);
    deleteCookie(c,MAIL_COOKIE,{secure:true,httpOnly:true,sameSite:'Lax',path:'/'});
    return c.json({success:true});
}
