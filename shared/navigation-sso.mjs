import { passwordDigest, randomAppPassword } from './passwords.mjs';
export const NAV_SESSION_SECONDS = 400 * 86400;
export const MAIL_SESSION_HOURS = [1, 8, 24, 168];
export const MAIL_COOKIE = '__Host-ionacs_mail';
const currentTime = () => Math.floor(Date.now()/1000);
export async function createMailTicket(db, sessionToken, hours) {
 if (!MAIL_SESSION_HOURS.includes(hours)) throw new Error('Invalid mailbox duration');
 const sessionHash=await passwordDigest(sessionToken), now=currentTime();
 const identity=await db.prepare(`SELECT s.address_id,s.password_version,a.password FROM nav_sessions s JOIN address a ON a.id=s.address_id WHERE s.token_hash=? AND s.expires_at>?`).bind(sessionHash,now).first();
 if(!identity||identity.password_version!==await passwordDigest(identity.password||''))throw new Error('Navigation session expired');
 const ticket=randomAppPassword();
 await db.prepare('INSERT INTO nav_mail_tickets VALUES(?,?,?,?,?,?)').bind(await passwordDigest(ticket),sessionHash,identity.address_id,identity.password_version,now+300,hours*3600).run();
 return ticket;
}
export async function consumeMailTicket(db,ticket) {
 if(typeof ticket!=='string'||!/^[a-f0-9]{48}$/.test(ticket))throw new Error('Invalid ticket');
 // DELETE RETURNING atomically consumes the ticket; concurrent exchanges cannot both succeed.
 const row=await db.prepare('DELETE FROM nav_mail_tickets WHERE token_hash=? AND expires_at>? RETURNING *').bind(await passwordDigest(ticket),currentTime()).first();
 if(!row)throw new Error('Ticket expired or already used');
 const identity=await validateMailIdentity(db,{address_id:row.address_id,nav_session:row.session_hash,password_version:row.password_version,exp:currentTime()+row.mail_seconds});
 if(!identity)throw new Error('Navigation session expired');
 return {address:identity.name,address_id:identity.id,scope:'navigation-mail',nav_session:row.session_hash,password_version:row.password_version,iat:currentTime(),exp:currentTime()+row.mail_seconds};
}
export async function validateMailIdentity(db,claims) {
 if(!Number.isFinite(claims.exp)||claims.exp<=currentTime()||!Number.isSafeInteger(claims.address_id)||typeof claims.nav_session!=='string'||typeof claims.password_version!=='string')return null;
 const row=await db.prepare(`SELECT a.id,a.name,a.password,s.password_version FROM address a JOIN nav_sessions s ON s.address_id=a.id WHERE a.id=? AND s.token_hash=? AND s.expires_at>?`).bind(claims.address_id,claims.nav_session,currentTime()).first();
 if(!row||row.password_version!==claims.password_version||await passwordDigest(row.password||'')!==claims.password_version)return null;
 return {id:row.id,name:row.name};
}
