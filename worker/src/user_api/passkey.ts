import { checkCfTurnstile } from '../utils';
import { Context } from 'hono';
import { userToken } from '../sessions';
import { storeChallenge, validChallenge, consumeChallenge } from '../../../shared/sessions.mjs';
import {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse
} from '@simplewebauthn/server';

import { Passkey } from '../models';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import i18n from '../i18n';

export default {
    getPassKeys: async (c: Context<HonoCustomType>) => {
        const user = c.get("userPayload");
        const { results } = await c.env.DB.prepare(
            `SELECT passkey_name, passkey_id, created_at, updated_at FROM user_passkeys WHERE user_id = ?`
        ).bind(user.user_id).all<Record<string, string>>();
        return c.json(results);
    },
    renamePassKey: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        const user = c.get("userPayload");
        const { passkey_id, passkey_name } = await c.req.json();
        if (!passkey_name || passkey_name.length > 255) {
            return c.text(msgs.InvalidPasskeyNameMsg, 400);
        }
        const { success } = await c.env.DB.prepare(
            `UPDATE user_passkeys SET passkey_name = ? WHERE user_id = ? AND passkey_id = ?`
        ).bind(passkey_name, user.user_id, passkey_id).run();
        return c.json({ success });
    },
    deletePassKey: async (c: Context<HonoCustomType>) => {
        const user = c.get("userPayload");
        const { passkey_id } = c.req.param();
        const { success } = await c.env.DB.prepare(
            `DELETE FROM user_passkeys WHERE user_id = ? AND passkey_id = ?`
        ).bind(user.user_id, passkey_id).run();
        return c.json({ success });
    },
    registerRequest: async (c: Context<HonoCustomType>) => {
        const user = c.get("userPayload");
        const { results } = await c.env.DB.prepare(
            `SELECT passkey FROM user_passkeys WHERE user_id = ?`
        ).bind(user.user_id).all<Record<string, string>>();
        const excludeCredentials = results
            .map((record: any) => JSON.parse(record.passkey) as Passkey)
            .map((passkey: Passkey) => ({
                id: passkey.id,
                transports: passkey.transports,
            }));
        // Use SimpleWebAuthn's handy function to create registration options.
        const options = await generateRegistrationOptions({
            rpName: c.env.TITLE || "Temp Mail",
            rpID: 'mail.ionacs.com',
            userID: new TextEncoder().encode(user.user_id.toString()),
            userName: user.user_email,
            userDisplayName: user.user_email,
            attestationType: 'none',
            excludeCredentials: excludeCredentials,
        });

        await storeChallenge(c.env.DB,options.challenge,'passkey-register',user.user_id);
        return c.json(options);
    },
    registerResponse: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        const user = c.get("userPayload");
        const { credential, passkey_name } = await c.req.json();
        if(typeof passkey_name!=='string'||!passkey_name.trim()||passkey_name.length>255)return c.text('无效的通行密钥名称',400);
        let usedChallenge='';
        // Verify the registration response
        const verification = await verifyRegistrationResponse({
            response: credential,
            expectedChallenge: async (challenge: string) => {
                usedChallenge=challenge;
                return validChallenge(c.env.DB,challenge,'passkey-register',user.user_id);
            },
            expectedRPID:'mail.ionacs.com',
            expectedOrigin: 'https://mail.ionacs.com',
            requireUserVerification: true,
        }).catch(() => null);
        if (!verification) return c.text('通行密钥验证失败，请重新开始',400);
        const { verified, registrationInfo } = verification;

        if (!verified || !registrationInfo) {
            return c.text(msgs.RegistrationFailedMsg, 400);
        }

        const {
            credential: verifiedCredential, credentialDeviceType, credentialBackedUp,
        } = registrationInfo;

        if (!await consumeChallenge(c.env.DB,usedChallenge,'passkey-register',user.user_id))return c.text('验证已失效，请重新开始',400);
        const {id:credentialID,publicKey:credentialPublicKey,counter}=verifiedCredential;
        // Base64URL encode ArrayBuffers.
        const base64PublicKey = isoBase64URL.fromBuffer(credentialPublicKey);

        const newPasskey: Passkey = {
            id: credentialID,
            publicKey: base64PublicKey,
            counter,
            deviceType: credentialDeviceType,
            backedUp: credentialBackedUp,
            transports: credential?.response?.transports,
        };

        // Store the credential ID in the database
        const { success } = await c.env.DB.prepare(
            `INSERT INTO user_passkeys (user_id, passkey_name, passkey_id, passkey, counter) VALUES (?, ?, ?, ?, ?)`
        ).bind(user.user_id, passkey_name, credentialID, JSON.stringify(newPasskey), counter).run();

        return c.json({ success });
    },
    authenticateRequest: async (c: Context<HonoCustomType>) => {
        const {cf_token}=await c.req.json();
        try { await checkCfTurnstile(c,cf_token,'user_login'); } catch { return c.text('请完成人机验证后重试',403); }
        const options = await generateAuthenticationOptions({
            rpID:'mail.ionacs.com', allowCredentials:[], userVerification:'required',
        });
        await storeChallenge(c.env.DB,options.challenge,'passkey-auth','');
        return c.json(options);
    },
    authenticateResponse: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        const { credential } = await c.req.json();
        let usedChallenge='';
        const passkey_id = credential?.id;
        if (!passkey_id) {
            return c.text(msgs.InvalidInputMsg, 400);
        }
        const { user_id, counter, passkey } = await c.env.DB.prepare(
            `SELECT user_id, counter, passkey FROM user_passkeys WHERE passkey_id = ?`
        ).bind(passkey_id).first<{
            counter: number; passkey: string; user_id: number;
        }>() || {};
        if (!passkey) {
            return c.text(msgs.PasskeyNotFoundMsg, 404);
        }
        const passkeyData = JSON.parse(passkey) as Passkey;
        // Verify the registration response
        const verification = await verifyAuthenticationResponse({
            response: credential,
            expectedChallenge: async (challenge: string) => {
                usedChallenge=challenge;
                return validChallenge(c.env.DB,challenge,'passkey-auth','');
            },
            requireUserVerification:true,
            expectedOrigin: 'https://mail.ionacs.com',
            expectedRPID: 'mail.ionacs.com',
            credential: {
                id: passkeyData.id,
                publicKey: isoBase64URL.toBuffer(passkeyData.publicKey),
                counter: counter ?? passkeyData.counter,
                transports: passkeyData.transports,
            },
        }).catch(() => null);
        if (!verification) return c.text('通行密钥验证失败，请重新开始',400);
        const { verified, authenticationInfo } = verification;
        if (!verified) {
            return c.text(msgs.AuthenticationFailedMsg, 400);
        }

        if (!await consumeChallenge(c.env.DB,usedChallenge,'passkey-auth','')) return c.text('验证已失效，请重新开始',400);
        if (authenticationInfo) {
            const { newCounter } = authenticationInfo;
            // Update the counter in the database
            await c.env.DB.prepare(
                `UPDATE user_passkeys SET counter = ? WHERE passkey_id = ?`
            ).bind(newCounter, passkey_id).run();
        }
        // update passkey updated_at
        await c.env.DB.prepare(
            `UPDATE user_passkeys SET updated_at = datetime('now') WHERE passkey_id = ?`
        ).bind(passkey_id).run();

        // return jwt
        const { user_email } = await c.env.DB.prepare(
            `SELECT user_email FROM users WHERE id = ?`
        ).bind(user_id).first<{ user_email: string }>() || {};
        if (!user_email) {
            return c.text(msgs.UserNotFoundMsg, 404);
        }
        // create jwt
        const jwt = await userToken(c.env,Number(user_id),user_email);
        return c.json({
            jwt: jwt
        })
    },
}
