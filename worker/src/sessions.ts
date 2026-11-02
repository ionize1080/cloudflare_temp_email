import { Jwt } from 'hono/utils/jwt';
import { sessionClaims } from '../../shared/sessions.mjs';
export async function mailboxToken(env:Bindings,id:number|string,email:string) {
    return Jwt.sign(await sessionClaims(env.DB,'mailbox',Number(id),email),env.JWT_SECRET,'HS256');
}
export async function userToken(env:Bindings,id:number,email:string) {
    return Jwt.sign(await sessionClaims(env.DB,'user',id,email),env.JWT_SECRET,'HS256');
}
