import { Context } from 'hono';
import { userToken } from '../sessions';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { storeChallenge, consumeChallenge } from '../../../shared/sessions.mjs';

import i18n from '../i18n';
import { checkCfTurnstile, getJsonSetting, getStringValue, getUserRoles } from '../utils';
import { UserOauth2Settings } from '../models';
import { CONSTANTS } from '../constants';


export default {
    getOauth2LoginUrl: async (c: Context<HonoCustomType>) => {
        const settings = await getJsonSetting<UserOauth2Settings[]>(c, CONSTANTS.OAUTH2_SETTINGS_KEY);
        const { clientID,cf_token } = await c.req.json();
        try { await checkCfTurnstile(c,cf_token,'user_login'); } catch { return c.text('请完成人机验证后重试',403); }
        const msgs = i18n.getMessagesbyContext(c);
        const setting = settings?.find(s => s.clientID === clientID);
        if (!setting) {
            return c.text(msgs.Oauth2ClientIDNotFoundMsg, 400);
        }
        const state=crypto.randomUUID();
        await storeChallenge(c.env.DB,state,'oauth',clientID);
        setCookie(c,'__Host-ionacs-oauth',state,{httpOnly:true,secure:true,sameSite:'Lax',path:'/',maxAge:300});
        const url=new URL(setting.authorizationURL);
        if(url.protocol!=='https:')return c.text('登录服务配置无效',400);
        for(const [key,value] of Object.entries({client_id:setting.clientID,response_type:'code',redirect_uri:setting.redirectURL,scope:setting.scope,state}))url.searchParams.set(key,value);
        return c.json({url:url.toString(),state});
    },
    oauth2Login: async (c: Context<HonoCustomType>) => {
        const { clientID, code, state } = await c.req.json<{ clientID?: string, code?: string, state?: string }>();
        const msgs = i18n.getMessagesbyContext(c);
        if (!clientID || !code) {
            return c.text(msgs.Oauth2CliendIDOrCodeMissingMsg, 400);
        }
        const settings = await getJsonSetting<UserOauth2Settings[]>(c, CONSTANTS.OAUTH2_SETTINGS_KEY);
        const setting = settings?.find(s => s.clientID === clientID);
        if (!setting) {
            return c.text(msgs.Oauth2ClientIDNotFoundMsg, 400);
        }
        if(typeof state!=='string'||state!==getCookie(c,'__Host-ionacs-oauth')||!await consumeChallenge(c.env.DB,state,'oauth',clientID))return c.text('登录验证已失效，请重新开始',400);
        deleteCookie(c,'__Host-ionacs-oauth',{path:'/',secure:true});
        if(![setting.accessTokenURL,setting.userInfoURL].every(value=>new URL(value).protocol==='https:'))return c.text('登录服务配置无效',400);
        const params = {
            code,
            client_id: setting.clientID,
            client_secret: setting.clientSecret,
            grant_type: 'authorization_code',
            redirect_uri: setting.redirectURL,
        }
        const res = await fetch(setting.accessTokenURL, {
            method: 'POST', redirect:'manual', signal:AbortSignal.timeout(15000),
            body: setting.accessTokenFormat === 'json'
                ? JSON.stringify(params) :
                new URLSearchParams(params).toString(),
            headers: {
                'Content-Type': setting.accessTokenFormat === 'json'
                    ? 'application/json'
                    : 'application/x-www-form-urlencoded',
                "Accept": "application/json"
            }
        })
        if (!res.ok) {
            console.warn(JSON.stringify({event:"oauth_token_failed",status:res.status}))
            return c.text(msgs.Oauth2FailedGetAccessTokenMsg, 400);
        }
        const resJson = await res.json();
        const { access_token, token_type } = resJson as { access_token: string, token_type?: string };
        const userRes = await fetch(setting.userInfoURL, {
            redirect:"manual",signal:AbortSignal.timeout(15000),
            headers: {
                "Authorization": `${token_type || 'Bearer'} ${access_token}`,
                "Accept": "application/json",
                "User-Agent": "Cloudflare Workers"
            }
        })
        if (!userRes.ok) {
            console.warn(JSON.stringify({event:"oauth_profile_failed",status:userRes.status}))
            return c.text(msgs.Oauth2FailedGetUserInfoMsg, 400);
        }
        const userInfo = await userRes.json<any>()

        const email = await (async () => {
            if (setting.userEmailKey.startsWith("$")) {
                const { JSONPath } = await import('jsonpath-plus');
                const email = JSONPath({
                    path: setting.userEmailKey,
                    json: userInfo,
                })
                if (email && Array.isArray(email) && email.length > 0) {
                    return email[0];
                }
            }
            const { [setting.userEmailKey]: email } = userInfo as { [key: string]: string };
            return email;
        })()

        if (typeof email!=='string'||email.length>254||userInfo.email_verified!==true) {
            return c.text(msgs.Oauth2FailedGetUserEmailMsg, 400);
        }
        // check email in mail allow list
        const mailDomain = email.split("@")[1];
        if (setting.enableMailAllowList && !setting.mailAllowList?.includes(mailDomain)) {
            return c.text(`${msgs.UserMailDomainMustInMsg} ${JSON.stringify(setting.mailAllowList, null, 2)}`, 400)
        }
        if (!await c.env.DB.prepare('SELECT id FROM users WHERE user_email=?').bind(email).first()) return c.text('新用户请使用邮箱主页的邀请码注册', 403);
        // insert or update user
        const { success } = await c.env.DB.prepare(
            `INSERT INTO users (user_email, password, user_info)`
            + ` VALUES (?, '', ?)`
            + ` ON CONFLICT(user_email) DO UPDATE SET updated_at = datetime('now')`
        ).bind(
            email, JSON.stringify(userInfo)
        ).run();
        if (!success) {
            return c.text(msgs.FailedToRegisterMsg, 500)
        }
        const { id: user_id } = await c.env.DB.prepare(
            `SELECT id FROM users where user_email = ?`
        ).bind(email).first() || {};
        if (!user_id) {
            return c.text(msgs.UserNotFoundMsg, 400)
        }
        // process user roles
        const defaultRole = getStringValue(c.env.USER_DEFAULT_ROLE);
        if (defaultRole) {
            const user_roles = getUserRoles(c);
            if (!user_roles.find((r) => r.role === defaultRole)) {
                return c.text(msgs.InvalidUserDefaultRoleMsg, 500);
            }
            // update user roles
            const { success: success2 } = await c.env.DB.prepare(
                `INSERT INTO user_roles (user_id, role_text)`
                + ` VALUES (?, ?)`
                + ` ON CONFLICT(user_id) DO NOTHING`
            ).bind(user_id, defaultRole).run();
            if (!success2) {
                return c.text(msgs.FailedUpdateUserDefaultRoleMsg, 500);
            }
        }
        // create jwt
        const jwt = await userToken(c.env,Number(user_id),email);
        return c.json({
            jwt: jwt
        })
    }
}
