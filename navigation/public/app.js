import { suggestWebsites, matchWebsite } from './catalog.mjs';
import { starterLinks } from './defaults.mjs';
import { icon, websiteIcon, productVectors } from './icons.mjs';
import { createTurnstileLoader } from './turnstile-loader.mjs';
const getTurnstile=createTurnstileLoader();
let challengeGeneration=0;
const $=s=>document.querySelector(s), defaults={wallpaper_mode:'bing',wallpaper_url:'',color:'#e8f0fe',search_engine:'google',mail_session_hours:24};
let user=null,prefs={...defaults},images=[],bookmarks=[],config={},authMode='login',widgetId,challengeToken='',editing=null,imageGeneration=0;

function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,4500);}
async function api(path,options={}){const res=await fetch('/api'+path,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...options.headers}});let data;try{data=await res.json();}catch{throw new Error('服务暂时不可用，请稍后重试');}if(!res.ok){if(res.status===401&&user)clearAccount();throw new Error(data.error||'操作失败，请重试');}return data;}
const send=(path,method,data)=>api(path,{method,body:data===undefined?undefined:JSON.stringify(data)});
const showDialog=id=>$(id).showModal();
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}}));
function renderAccount(){$('#account-button').textContent=user?user.email.split('@')[0]:'登录';$('#account-button').title=user?.email||'登录你的 IONACS 账户';$('#logout-button').hidden=!user;$('#admin-button').hidden=!user?.admin;$('#sync-note').textContent=user?'收藏与偏好已同步':'登录后，同步你的收藏与偏好';}
function clearAccount(){user=null;bookmarks=[];images=[];prefs={...defaults};renderAccount();renderBookmarks();applyBackground();document.querySelectorAll('dialog[open]').forEach(d=>d.close());}
function renderBookmarks(){
 const container=$('#shortcuts');container.replaceChildren();
 const links=user?bookmarks:starterLinks;
 $('#collection-label').textContent=user?`${links.length} 个收藏`:'SHORTCUTS';
 for(const item of links){
  const wrap=document.createElement('div');wrap.className='shortcut';
  const link=document.createElement('a');link.href=item.url;link.target='_blank';link.rel='noopener noreferrer';link.title=item.title;
  const mark=document.createElement('span'),kind=websiteIcon(item.url);mark.className='shortcut-icon icon-'+kind;setWebsiteMark(mark,item.url,item);
  const title=document.createElement('span');title.className='shortcut-title';title.textContent=item.title;
  const domain=document.createElement('span');domain.className='shortcut-domain';domain.textContent=new URL(item.url).hostname.replace(/^www\./,'');
  link.append(mark,title,domain);wrap.append(link);
  if(user){const edit=document.createElement('button');edit.className='edit';edit.innerHTML=icon('more');edit.ariaLabel='编辑 '+item.title;edit.addEventListener('click',()=>openBookmark(item));wrap.append(edit);}
  container.append(wrap);
 }
 const add=document.createElement('div');add.className='shortcut add-shortcut';
 const button=document.createElement('button');button.className='add';button.innerHTML=`<span class="shortcut-icon">${icon('plus')}</span><span class="shortcut-title">添加网站</span><span class="shortcut-domain">自定义网址</span>`;
 button.addEventListener('click',()=>user?openBookmark():openAuth());add.append(button);container.append(add);
}

function updateSearch(){const names={google:'Google',bing:'Bing',baidu:'百度'};$('#search-input').placeholder=`在 ${names[prefs.search_engine]} 搜索，或输入网址`;$('#search-engine-icon').innerHTML=icon(prefs.search_engine);}
$('#search-form').addEventListener('submit',e=>{e.preventDefault();const query=$('#search-input').value.trim();if(!query)return;let target='';try{const candidate=/^https?:\/\//i.test(query)?query:/^[^\s/:]+\.[^\s]+$/.test(query)?'https://'+query:'';if(candidate){const u=new URL(candidate);if(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password)target=u.href;}}catch{}const engines={google:'https://www.google.com/search?q=',bing:'https://www.bing.com/search?q=',baidu:'https://www.baidu.com/s?wd='};location.assign(target||engines[prefs.search_engine]+encodeURIComponent(query));});
async function loadAccount(){renderAccount();const [saved,settings]=await Promise.all([api('/bookmarks'),api('/preferences')]);if(!user)return;bookmarks=saved.bookmarks;prefs={...defaults,...settings.preferences};renderBookmarks();updateSearch();await loadWallpapers();applyBackground();}
async function loadWallpapers(){if(!user)return;try{const data=await api('/wallpapers');if(user)images=data.images||[];}catch{if(user)toast('壁纸暂不可用，已保留纯色背景');}}
function applyBackground(){const generation=++imageGeneration,backdrop=$('#backdrop');backdrop.style.backgroundImage='none';document.body.classList.remove('has-image');$('#photo-credit').hidden=true;$('#footer-note').hidden=false;backdrop.style.backgroundColor=user?prefs.color:'#ffffff';updateSearch();if(!user||prefs.wallpaper_mode==='color')return;const chosen=prefs.wallpaper_mode==='bing'?images[0]:images.find(x=>x.originalURL===prefs.wallpaper_url||x.url===prefs.wallpaper_url);const url=chosen?.url||(prefs.wallpaper_mode==='image'?prefs.wallpaper_url:'');if(!url)return;let parsed;try{parsed=new URL(url,location.origin);if(parsed.origin!==location.origin&&parsed.protocol!=='https:')return;}catch{return;}const image=new Image();image.referrerPolicy='no-referrer';image.onload=()=>{if(!user||generation!==imageGeneration)return;backdrop.style.backgroundImage=`url(${JSON.stringify(parsed.href)})`;document.body.classList.add('has-image');if(chosen){$('#photo-credit').textContent=chosen.copyright;$('#photo-credit').href=chosen.link;$('#photo-credit').hidden=false;$('#footer-note').hidden=true;}};image.onerror=()=>{if(user&&generation===imageGeneration)toast('这张壁纸暂时无法加载，已使用纯色背景');};image.src=parsed.href;}
async function renderChallenge(){const generation=++challengeGeneration;challengeToken='';$('#auth-submit').disabled=true;try{if(!config.siteKey)throw new Error('登录服务正在配置，请稍后再试');await getTurnstile();if(generation!==challengeGeneration)return;if(widgetId!==undefined)window.turnstile.remove(widgetId);widgetId=window.turnstile.render('#auth-challenge',{sitekey:config.siteKey,action:authMode,theme:'light',callback:token=>{challengeToken=token;$('#auth-submit').disabled=false;},'expired-callback':()=>{challengeToken='';$('#auth-submit').disabled=true;},'error-callback':()=>{challengeToken='';$('#auth-error').textContent='验证暂不可用，请关闭窗口后重试';$('#auth-submit').disabled=true;}});}catch(e){$('#auth-error').textContent=e.message;}}
function setAuthMode(mode){authMode=mode;const registering=mode==='register';$('#auth-title').textContent=registering?'创建你的账户':'欢迎回来';$('#auth-description').textContent=registering?'一份邀请，开启你的 IONACS 空间。':'使用你的 IONACS 邮箱账户登录。';$('#tab-login').classList.toggle('active',!registering);$('#tab-register').classList.toggle('active',registering);$('#invite-field').hidden=!registering;$('#register-hint').hidden=!registering;$('#auth-form').elements.invite.required=registering;$('#auth-form').elements.password.autocomplete=registering?'new-password':'current-password';$('#auth-form').elements.password.minLength=registering?12:1;$('#auth-submit').textContent=registering?'注册并登录':'登录';$('#auth-error').textContent='';renderChallenge();}
function openAuth(){showDialog('#auth-dialog');setAuthMode('login');}
$('#account-button').addEventListener('click',()=>user?openCustomize():openAuth());$('#tab-login').addEventListener('click',()=>setAuthMode('login'));$('#tab-register').addEventListener('click',()=>setAuthMode('register'));
$('#auth-form').addEventListener('submit',async e=>{e.preventDefault();$('#auth-submit').disabled=true;$('#auth-error').textContent='';const values=Object.fromEntries(new FormData(e.target));try{if(!challengeToken)throw new Error('请先完成人机验证');const data=await send('/'+authMode,'POST',{...values,token:challengeToken});user=data.user;$('#auth-dialog').close();e.target.reset();await loadAccount();toast(authMode==='register'?'账户已创建，欢迎加入':'登录成功');}catch(err){$('#auth-error').textContent=err.message;if(user)toast(err.message);}finally{challengeToken='';if(window.turnstile&&widgetId!==undefined)window.turnstile.reset(widgetId);}});
$('#logout-button').addEventListener('click',async()=>{try{await send('/logout','POST');clearAccount();toast('已退出登录');}catch(e){toast(e.message);}});
function setWebsiteMark(element,url,item=null){
 const kind=websiteIcon(url),site=matchWebsite(url);element.replaceChildren();
 if(site&&productVectors.has(site.id)){element.innerHTML=icon(site.id);return;}
 if(user&&item&&kind==='globe'&&!site?.icon){
  element.innerHTML=icon('globe');
  const image=document.createElement('img');image.alt='';image.width=28;image.height=28;
  image.onload=()=>element.replaceChildren(image);image.src=item.iconData||'/api/bookmarks/'+item.id+'/icon?v='+(item.iconRevision||0);return;
 }
 if(kind!=='globe'||!site||!site.icon){element.innerHTML=icon(kind);return;}
 const image=document.createElement('img');image.src=site.icon;image.alt='';image.width=28;image.height=28;
 image.onerror=()=>{element.innerHTML=icon('globe');};element.append(image);
}
let suggestions=[],suggestionIndex=-1,suggestionInput=null;
function closeSuggestions(){
 $('#website-suggestions').hidden=true;suggestions=[];suggestionIndex=-1;
 for(const field of [$('#bookmark-form').elements.title,$('#bookmark-form').elements.url]){field.setAttribute('aria-expanded','false');field.removeAttribute('aria-activedescendant');}
}
function updateBookmarkPreview(){
 const form=$('#bookmark-form'),value=form.elements.url.value.trim();
 $('#bookmark-preview-title').textContent=form.elements.title.value.trim()||'你的网站';
 let url;try{url=new URL(value);}catch{}
 $('#bookmark-preview-domain').textContent=url?.hostname||'名称与图标将在这里预览';
 const saved=editing&&editing.url===value?editing:null;
 setWebsiteMark($('#bookmark-preview-icon'),value,saved);
 $('#refresh-bookmark-icon').hidden=!saved||websiteIcon(value)!=='globe'||!!matchWebsite(value)?.icon;
}
function chooseSuggestion(site){
 const form=$('#bookmark-form');form.elements.title.value=site.name;form.elements.url.value=site.url;
 closeSuggestions();updateBookmarkPreview();form.elements.title.focus();
}
function showSuggestions(input){
 suggestionInput=input;suggestions=suggestWebsites(input.value);suggestionIndex=-1;
 const panel=$('#website-suggestions'),list=$('#website-results');list.replaceChildren();
 panel.style.top=input.name==='title'?(input.offsetTop+input.offsetHeight+7)+'px':'auto';
 panel.style.bottom=input.name==='url'?(input.closest('.website-fields').offsetHeight-input.offsetTop+7)+'px':'auto';
 panel.hidden=!suggestions.length;input.setAttribute('aria-expanded',String(!!suggestions.length));input.removeAttribute('aria-activedescendant');
 $('#suggestion-label').textContent=input.value.trim()?'匹配的网站':'常用网站';
 for(const [index,site]of suggestions.entries()){
  const option=document.createElement('div');option.className='website-option';option.id='website-option-'+index;option.setAttribute('role','option');option.setAttribute('aria-selected','false');
  const mark=document.createElement('span');mark.className='suggestion-icon';setWebsiteMark(mark,site.url);
  const text=document.createElement('span');text.className='suggestion-text';const name=document.createElement('strong');name.textContent=site.name;const address=document.createElement('small');address.textContent=new URL(site.url).hostname;text.append(name,address);
  const arrow=document.createElement('span');arrow.className='suggestion-arrow';arrow.innerHTML=icon('arrow');option.append(mark,text,arrow);
  option.addEventListener('pointerdown',e=>e.preventDefault());option.addEventListener('click',()=>chooseSuggestion(site));
  option.addEventListener('pointermove',()=>setActiveSuggestion(index));list.append(option);
 }
}
function setActiveSuggestion(index){suggestionIndex=index;$('#website-results').querySelectorAll('[role=option]').forEach((node,i)=>{node.setAttribute('aria-selected',String(i===index));if(i===index)node.scrollIntoView({block:'nearest'});});suggestionInput?.setAttribute('aria-activedescendant','website-option-'+index);}
for(const input of [$('#bookmark-form').elements.title,$('#bookmark-form').elements.url]){
 input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-controls','website-results');input.setAttribute('aria-expanded','false');input.autocomplete='off';
 input.addEventListener('input',()=>{showSuggestions(input);updateBookmarkPreview();});
 input.addEventListener('keydown',e=>{
  if($('#website-suggestions').hidden)return;
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();setActiveSuggestion((suggestionIndex+(e.key==='ArrowDown'?1:-1)+suggestions.length)%suggestions.length);}
  else if(e.key==='Enter'&&suggestionIndex>=0){e.preventDefault();chooseSuggestion(suggestions[suggestionIndex]);}
  else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeSuggestions();}
 });
 input.addEventListener('blur',()=>{if(!$('#website-suggestions').matches(':hover'))closeSuggestions();});
}
$('#bookmark-dialog').addEventListener('close',closeSuggestions);
document.addEventListener('pointerdown',e=>{if(!e.target.closest('#website-suggestions,input[name=title],input[name=url]'))closeSuggestions();});
function openBookmark(item=null){
 editing=item;$('#bookmark-title').textContent=item?'编辑快捷方式':'添加快捷方式';
 const form=$('#bookmark-form');form.elements.title.value=item?.title||'';form.elements.url.value=item?.url||'';form.querySelector('.form-error').textContent='';$('#delete-bookmark').hidden=!item;
 closeSuggestions();updateBookmarkPreview();showDialog('#bookmark-dialog');form.elements.title.focus();
}

$('#bookmark-form').addEventListener('submit',async e=>{e.preventDefault();const button=e.target.querySelector('[type=submit]');button.disabled=true;try{await send(editing?'/bookmarks/'+editing.id:'/bookmarks',editing?'PATCH':'POST',Object.fromEntries(new FormData(e.target)));bookmarks=(await api('/bookmarks')).bookmarks;renderBookmarks();$('#bookmark-dialog').close();toast('收藏已保存');}catch(err){e.target.querySelector('.form-error').textContent=err.message;}finally{button.disabled=false;}});
$('#refresh-bookmark-icon').addEventListener('click',async()=>{
 if(!editing)return;const item=editing,button=$('#refresh-bookmark-icon');button.disabled=true;button.textContent='正在获取…';
 try{const result=await send('/bookmarks/'+item.id+'/icon','POST');item.iconRevision=Date.now();if(result.image)item.iconData=result.image;renderBookmarks();if(editing===item)updateBookmarkPreview();toast(result.message);}
 catch(error){toast(error.message);}finally{button.disabled=false;button.textContent='刷新图标';}
});
$('#delete-bookmark').addEventListener('click',async()=>{if(!editing)return;try{await send('/bookmarks/'+editing.id,'DELETE');bookmarks=(await api('/bookmarks')).bookmarks;renderBookmarks();$('#bookmark-dialog').close();toast('收藏已删除');}catch(e){$('#bookmark-form .form-error').textContent=e.message;}});
function displayPreferenceFields(){const mode=$('#preferences-form').elements.wallpaper_mode.value;$('#color-field').hidden=mode!=='color';$('#image-field').hidden=mode!=='image';}
function renderGallery(){const grid=$('#wallpaper-grid');grid.replaceChildren();if(!images.length){grid.textContent='壁纸暂未准备好，请稍后再试。';return;}for(const item of images){const button=document.createElement('button');button.type='button';button.className='wallpaper-tile';button.title=item.copyright;const img=document.createElement('img');img.src=item.thumbnail;img.alt=item.title;img.loading='lazy';const date=document.createElement('span');date.textContent=item.day.slice(0,4)+'.'+item.day.slice(4,6)+'.'+item.day.slice(6);button.append(img,date);button.addEventListener('click',()=>{const form=$('#preferences-form');form.elements.wallpaper_mode.value='image';form.elements.wallpaper_url.value=item.originalURL;displayPreferenceFields();grid.querySelectorAll('button').forEach(b=>b.classList.remove('selected'));button.classList.add('selected');});grid.append(button);}}
function openCustomize(){if(!user){openAuth();return;}const form=$('#preferences-form');for(const[key,value]of Object.entries(prefs))if(form.elements[key])form.elements[key].value=value;form.querySelector('.form-error').textContent='';displayPreferenceFields();renderGallery();showDialog('#customize-dialog');}
$('#customize-button').addEventListener('click',openCustomize);$('#preferences-form').addEventListener('change',displayPreferenceFields);
$('#preferences-form').addEventListener('submit',async e=>{e.preventDefault();const button=e.target.querySelector('[type=submit]');button.disabled=true;try{const next=Object.fromEntries(new FormData(e.target));next.mail_session_hours=Number(next.mail_session_hours);await send('/preferences','PUT',next);prefs={...defaults,...next};applyBackground();$('#customize-dialog').close();toast('设置已保存');}catch(err){e.target.querySelector('.form-error').textContent=err.message;}finally{button.disabled=false;}});
async function renderInvites(){const{invites}=await api('/admin/invites');const list=$('#invite-list');list.replaceChildren();for(const invite of invites){const row=document.createElement('div');row.className='invite-row';const details=document.createElement('div'),label=document.createElement('strong'),note=document.createElement('p');label.textContent=invite.label;note.textContent=`已使用 ${invite.used}/${invite.max_uses} 次 · ${new Date(invite.expires_at*1000).toLocaleDateString('zh-CN')} 到期`;details.append(label,note);row.append(details);const revoke=document.createElement('button'),expired=invite.expires_at*1000<=Date.now();revoke.textContent=invite.revoked?'已停用':expired?'已过期':'停用';revoke.disabled=!!invite.revoked||expired;revoke.addEventListener('click',async()=>{try{await send('/admin/invites/'+invite.id,'DELETE');await renderInvites();}catch(e){toast(e.message);}});row.append(revoke);list.append(row);}if(!invites.length)list.textContent='还没有邀请码。';}
$('#admin-button').addEventListener('click',async()=>{$('#new-invite').hidden=true;showDialog('#admin-dialog');try{await renderInvites();}catch(e){toast(e.message);}});
$('#invite-form').addEventListener('submit',async e=>{e.preventDefault();const button=e.target.querySelector('[type=submit]');button.disabled=true;try{const data=Object.fromEntries(new FormData(e.target));data.days=Number(data.days);data.maxUses=Number(data.maxUses);const result=await send('/admin/invites','POST',data);$('#invite-code').value=result.code;$('#new-invite').hidden=false;await renderInvites();}catch(err){e.target.querySelector('.form-error').textContent=err.message;}finally{button.disabled=false;}});
$('#copy-invite').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('#invite-code').value);toast('邀请码已复制');}catch{$('#invite-code').select();toast('请复制选中的邀请码');}});
async function init(){document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));updateSearch();renderBookmarks();try{const[settings,account]=await Promise.all([api('/config'),api('/me')]);config=settings;user=account.user;if(user)await loadAccount();else renderAccount();}catch(e){toast(e.message);}}
let lastWallpaperCheck=Date.now();document.addEventListener('visibilitychange',async()=>{if(!document.hidden&&user&&Date.now()-lastWallpaperCheck>3600000){lastWallpaperCheck=Date.now();await loadWallpapers();applyBackground();}});init();

function updateDate(){$('#today-label').textContent=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'long'}).format(new Date());}updateDate();setInterval(updateDate,60000);
document.addEventListener('keydown',e=>{if(e.key==='/'&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&!document.querySelector('dialog[open]')&&!e.target.closest('input,textarea,select,[contenteditable]')){e.preventDefault();$('#search-input').focus();}});

// Open immediately within the user's click, then replace the blank tab with a one-use handoff.
document.addEventListener('click',async event=>{
 const link=event.target.closest('a[href]');if(!user||!link||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
 const target=new URL(link.href);if(target.origin!=='https://mail.ionacs.com'||target.pathname!=='/')return;
 event.preventDefault();const tab=window.open('about:blank','_blank');if(!tab){toast('请允许此网站打开新标签页后重试');return;}tab.opener=null;
 try{const result=await send('/mail-link','POST');tab.location.replace(result.url);}catch(error){if(tab)tab.close();toast(error.message);}
});
