export async function sessionVersion(db, kind, id) {
  return (await db.prepare('SELECT version FROM auth_versions WHERE kind=? AND subject=?').bind(kind,id).first())?.version ?? 0;
}

export async function sessionClaims(db, kind, id, email, purpose=kind, ttl=30*86400) {
  const now=Math.floor(Date.now()/1000);
  return {purpose, auth_version:await sessionVersion(db,kind,Number(id)),iat:now,exp:now+ttl,
    ...(kind==='mailbox'?{address_id:Number(id),address:email}:{user_id:Number(id),user_email:email})};
}

export async function validSession(db, payload, kind, purpose=kind) {
  const now=Math.floor(Date.now()/1000);
  const id=kind==='mailbox'?payload.address_id:payload.user_id;
  const email=kind==='mailbox'?payload.address:payload.user_email;
  if(!Number.isSafeInteger(id)||id<=0||typeof email!=='string'||!Number.isFinite(payload.exp)||payload.exp<=now
    ||(payload.iat!==undefined&&(!Number.isFinite(payload.iat)||payload.iat>now+30))
    ||(payload.purpose!==undefined&&payload.purpose!==purpose)
    ||(purpose==='user'&&payload.user_role!==undefined))return false;
  const exists=await db.prepare(kind==='mailbox'?'SELECT id FROM address WHERE id=? AND name=?':'SELECT id FROM users WHERE id=? AND user_email=?').bind(id,email).first();
  return !!exists && (payload.auth_version??0)===await sessionVersion(db,kind,id);
}

export async function storeChallenge(db, nonce, purpose, subject) {
  await db.prepare('DELETE FROM auth_challenges WHERE expires_at<=unixepoch()').run();
  await db.prepare('INSERT INTO auth_challenges(nonce,purpose,subject,expires_at) VALUES(?,?,?,unixepoch()+300)').bind(nonce,purpose,String(subject)).run();
}
export async function validChallenge(db, nonce, purpose, subject) {
  if(typeof nonce!=='string'||nonce.length>512)return false;
  return !!await db.prepare('SELECT nonce FROM auth_challenges WHERE nonce=? AND purpose=? AND subject=? AND expires_at>unixepoch()').bind(nonce,purpose,String(subject)).first();
}
export async function consumeChallenge(db, nonce, purpose, subject) {
  return !!await db.prepare('DELETE FROM auth_challenges WHERE nonce=? AND purpose=? AND subject=? AND expires_at>unixepoch() RETURNING nonce').bind(nonce,purpose,String(subject)).first();
}
