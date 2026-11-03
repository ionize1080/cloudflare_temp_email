export const SOURCE = 'https://raw.githubusercontent.com/niumoo/bing-wallpaper/main/bing-wallpaper.md';
export const SOURCE_PAGE = 'https://github.com/niumoo/bing-wallpaper';
export function parseWallpapers(markdown) {
  const images = [];
  for (const line of markdown.split('\n')) {
    const m = /^(\d{4}-\d{2}-\d{2})\s*\|\s*\[(.+)\]\((https:\/\/[^\s)]+)\)\s*$/.exec(line);
    if (!m) continue;
    const url = new URL(m[3]);
    if (!['cn.bing.com','www.bing.com'].includes(url.hostname) || url.pathname !== '/th' || !/^OHR\.[A-Za-z0-9_-]+\.jpg$/.test(url.searchParams.get('id') || '')) continue;
    const day = m[1].replaceAll('-','');
    if (images.some(x => x.day === day)) continue;
    images.push({ day, url: url.href, title: m[2].split(' (©')[0], copyright: m[2], link: SOURCE_PAGE });
  }
  return images.sort((a,b) => b.day.localeCompare(a.day)).slice(0,7);
}
export function imageURL(image, size) {
  const url = new URL(image.url);
  url.searchParams.set('w',size === 'thumb' ? '480' : '1920');
  url.searchParams.set('h',size === 'thumb' ? '270' : '1080');
  url.searchParams.set('c','4'); url.searchParams.set('rs','1'); return url.href;
}
export async function fetchSource() {
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('wallpaper_source_unavailable');
  const images = parseWallpapers(await res.text());
  if (!images.length) throw new Error('wallpaper_source_empty');
  return images;
}
export async function refreshWallpapers(env) {
  const images = await fetchSource();
  // Populate persistent image cache before making new metadata visible.
  for (const item of images) {
    for (const size of ['large','thumb']) {
      const key = `nav-wallpaper:${item.day}:${size}`;
      if (await env.WALLPAPERS.get(key, {type:'arrayBuffer'})) continue;
      const response = await fetch(imageURL(item,size), {signal:AbortSignal.timeout(15000)});
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error('wallpaper_image_unavailable');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 5*1024*1024) throw new Error('wallpaper_image_too_large');
      await env.WALLPAPERS.put(key,bytes,{expirationTtl:14*86400,metadata:{contentType:response.headers.get('content-type')}});
    }
  }
  await env.DB.batch(images.map(item => env.DB.prepare('INSERT INTO nav_wallpapers(day,payload,fetched_at) VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at').bind(item.day,JSON.stringify(item),Math.floor(Date.now()/1000))));
  await env.DB.prepare('DELETE FROM nav_wallpapers WHERE day NOT IN (SELECT day FROM nav_wallpapers ORDER BY day DESC LIMIT 7)').run();
}
export async function serveWallpaper(req,env,ctx,day,size) {
  const cached = await env.WALLPAPERS.getWithMetadata(`nav-wallpaper:${day}:${size}`,{type:'arrayBuffer'});
  if (!cached.value) return new Response('壁纸暂不可用',{status:404});
  // Authentication checked by caller. Private browser cache never shares sessions.
  return new Response(cached.value,{headers:{'Content-Type':cached.metadata?.contentType || 'image/jpeg','Cache-Control':'private, max-age=86400','Vary':'Cookie'}});
}
