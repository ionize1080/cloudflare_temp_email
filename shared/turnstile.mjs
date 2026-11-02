export async function verifyTurnstile(env, token, action, ip, send=fetch) {
  if(!env.CF_TURNSTILE_SITE_KEY && env.TURNSTILE_REQUIRED!=='true')return true;
  if(!env.CF_TURNSTILE_SECRET_KEY||typeof token!=='string'||!token.length||token.length>2048)return false;
  try {
    const response=await send('https://challenges.cloudflare.com/turnstile/v0/siteverify',{
      method:'POST',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({secret:env.CF_TURNSTILE_SECRET_KEY,response:token,...(ip?{remoteip:ip}:{})}),
    });
    if(!response.ok)return false;
    const result=await response.json();
    return result.success===true&&result.hostname==='mail.ionacs.com'&&result.action===action;
  } catch {return false;}
}
