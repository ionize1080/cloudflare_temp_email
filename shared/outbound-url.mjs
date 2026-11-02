// Optional user webhooks must target a public HTTPS hostname, never a local IP,
// metadata endpoint or alternate port. Redirects are checked by the caller.
export function publicHttpsUrl(value) {
  if(typeof value!=='string'||value.length>2048)throw new Error('Webhook URL 无效');
  const url=new URL(value), host=url.hostname.toLowerCase();
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')
    ||!host.includes('.')||host.endsWith('.')||host.includes(':')||/^\d+(\.\d+)*$/.test(host)
    ||/(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(host)
    ||host==='metadata.google.internal')throw new Error('Webhook 仅支持公共 HTTPS 域名');
  return url.toString();
}
export function webhookRequest(settings) {
  const url=publicHttpsUrl(settings.url);
  if(!['POST','PUT','PATCH'].includes(settings.method)||typeof settings.body!=='string'||settings.body.length>100000)throw new Error('Webhook 请求无效');
  const headers=JSON.parse(settings.headers);
  if(!headers||typeof headers!=='object'||Array.isArray(headers)||Object.keys(headers).length>20)throw new Error('Webhook 请求头无效');
  for(const [key,value] of Object.entries(headers)) {
    if(typeof value!=='string'||value.length>4096||/[\r\n]/.test(value)||/^(host|content-length|connection|transfer-encoding|cookie|cf-|x-forwarded-)/i.test(key))throw new Error('Webhook 请求头无效');
  }
  return {url,headers};
}
