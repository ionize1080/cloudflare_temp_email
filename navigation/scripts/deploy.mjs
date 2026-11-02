import {readFile,writeFile,unlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {refreshWallpapers} from '../src/wallpapers.mjs';
const config=JSON.parse(await readFile(new URL('../wrangler.json',import.meta.url),'utf8'));
const account=config.account_id; // The mailbox deployment config is authoritative.
const token=process.env.CLOUDFLARE_API_TOKEN?.trim();
if(!token)throw new Error('Missing CLOUDFLARE_API_TOKEN. Configure the Cloudflare Workers Builds deployment token.');
const base=`https://api.cloudflare.com/client/v4/accounts/${account}`;
async function cf(path,options={}){
 const res=await fetch(base+path,{...options,headers:{Authorization:`Bearer ${token}`,...options.headers},signal:AbortSignal.timeout(30000)});
 const data=await res.json();if(!res.ok||!data.success)throw new Error(`Cloudflare ${path.split('?')[0]}: ${(data.errors||[]).map(e=>e.message).join('; ')||res.status}`);return data.result;
}
function run(args,input){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args],{stdio:[input?'pipe':'ignore','inherit','inherit'],env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false',CLOUDFLARE_ACCOUNT_ID:account}});if(input)child.stdin.end(input);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`Deployment command failed (${code})`)));});}
const database=config.d1_databases[0].database_id;
async function sql(statement,params=[]){const result=await cf(`/d1/database/${database}/query`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sql:statement,params})});if(result.some(r=>!r.success))throw new Error('D1 query failed');return result;}
// Preflight before altering routing or publishing: verify the existing administrator identity.
const admin=await sql('SELECT id FROM address WHERE name=? AND password IS NOT NULL AND password != ?', [config.vars.ADMIN_EMAIL,'']);
if(!admin[0].results.length)throw new Error('The existing adrian@ionacs.com mailbox must have a password before deploying. No administrator password is created or changed by this script.');
let sitekey=process.env.TURNSTILE_SITE_KEY,secret=process.env.TURNSTILE_SECRET_KEY;
if(!sitekey||!secret){
 const widgets=await cf('/challenges/widgets');
 const existing=widgets.find(w=>w.name==='IONACS Navigation'&&w.domains?.includes('ionacs.com'));
 const widget=existing?await cf(`/challenges/widgets/${existing.sitekey}`):await cf('/challenges/widgets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'IONACS Navigation',domains:['ionacs.com'],mode:'managed',bot_fight_mode:false})});
 sitekey=widget.sitekey;secret=widget.secret;
}
if(!sitekey||!secret)throw new Error('Turnstile keys unavailable. Set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY build secrets or grant Account Turnstile Edit to the deployment token.');
// Prevent secret exposure through logs, including verbose CLI errors.
if(process.env.GITHUB_ACTIONS)console.log('::add-mask::'+secret);
config.vars.TURNSTILE_SITE_KEY=sitekey;config.account_id=account;
const configPath='wrangler.deploy.json';
try{
 await writeFile(configPath,JSON.stringify({...config,routes:[],workers_dev:false},null,2));
 await run(['d1','migrations','apply','DB','--remote','--config',configPath]);
 // Populate the most recent seven days before the first visitor arrives.
 const namespace=config.kv_namespaces[0].id;
 const DB={prepare(statement){return{bind(...params){return{async run(){return sql(statement,params);},statement,params};},async run(){return sql(statement);}};},async batch(statements){const results=[];for(const s of statements)results.push(await sql(s.statement,s.params));return results;}};
 const WALLPAPERS={async get(key){const res=await fetch(`${base}/storage/kv/namespaces/${namespace}/values/${encodeURIComponent(key)}`,{headers:{Authorization:`Bearer ${token}`}});if(res.status===404)return null;if(!res.ok)throw new Error('Wallpaper KV read failed');return res.arrayBuffer();},async put(key,value,options){const metadata=JSON.stringify(options.metadata);const form=new FormData();form.set('value',new Blob([value]));form.set('metadata',metadata);await cf(`/storage/kv/namespaces/${namespace}/values/${encodeURIComponent(key)}?expiration_ttl=${options.expirationTtl}`,{method:'PUT',body:form});}};
 await refreshWallpapers({DB,WALLPAPERS});
 // First deploy has no public route; a pre-existing deployment keeps its route on update.
 const existingWorker=await fetch(`${base}/workers/scripts/${config.name}/settings`,{headers:{Authorization:`Bearer ${token}`}});
 if(existingWorker.status===404)await run(['deploy','--config',configPath,'--minify']);
 else if(!existingWorker.ok)throw new Error('Unable to inspect existing Worker');
 await run(['secret','put','TURNSTILE_SECRET_KEY','--config',configPath],secret+'\n');
 await writeFile(configPath,JSON.stringify(config,null,2));
 await run(['deploy','--config',configPath,'--minify']);
 const response=await fetch('https://ionacs.com/api/config',{signal:AbortSignal.timeout(20000)});
 if(!response.ok||(await response.json()).siteKey!==sitekey)throw new Error('Deployment completed but public health verification failed. Inspect DNS and existing Access policies.');
 console.log('Verified deployment: https://ionacs.com');
}finally{await unlink(configPath).catch(()=>{});}
