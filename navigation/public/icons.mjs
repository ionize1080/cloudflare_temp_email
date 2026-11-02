const strokes = {
 search: '<circle cx="10.75" cy="10.75" r="6.75"/><path d="m16 16 4.5 4.5"/>',
 arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
 external: '<path d="M8 5H5v14h14v-3M13 5h6v6m0-6L9 15"/>',
 plus: '<path d="M12 5v14M5 12h14"/>',
 more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
 settings: '<path d="M4 7h16M4 17h16"/><rect x="7" y="4" width="4" height="6" rx="2" fill="currentColor" stroke="none"/><rect x="14" y="14" width="4" height="6" rx="2" fill="currentColor" stroke="none"/>',
 mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/>',
 globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
 compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-2.5 5.5L8 16l2.5-5.5Z"/>',
 close: '<path d="m6 6 12 12M18 6 6 18"/>',
 lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>'
};
const brands = {
 google: '<path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.89-1.74 2.98-4.31 2.98-7.36Z"/><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.06.96-3.38.96-2.6 0-4.81-1.76-5.6-4.12H3.05v2.59A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.4 13.92a6 6 0 0 1 0-3.84V7.49H3.05a10 10 0 0 0 0 9.02l3.35-2.59Z"/><path fill="#EA4335" d="M12 5.96c1.47 0 2.79.51 3.82 1.51l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.95 5.49l3.35 2.59A5.98 5.98 0 0 1 12 5.96Z"/>',
 github: '<path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12c0 4.42 2.87 8.17 6.84 9.49.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03a9.5 9.5 0 0 1 5 0c1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.4.1 2.65.64.7 1.03 1.6 1.03 2.69 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.59c0 .27.18.58.69.48A10 10 0 0 0 22 12c0-5.52-4.48-10-10-10Z"/>',
 youtube: '<rect x="1" y="4.5" width="22" height="15" rx="5" fill="#F03D3D"/><path d="m10 8 6 4-6 4Z" fill="white"/>',
 bing: '<path d="M5 2.5 10 5v11l8-4.3-4.5-2-1.4-5.2 7 3.5c3.9 2 4.4 7.4.5 9.8L10 23l-5-3Z" fill="#0AA6AC"/><path d="m10 16 8-4.3c2.1-1.2 1.9-2.7 1.1-3.7 3.9 2 4.4 7.4.5 9.8L10 23Z" fill="#1681B7"/>',
 baidu: '<circle cx="5" cy="7" r="2.5" fill="#3468E8"/><circle cx="11" cy="4.5" r="2.5" fill="#3468E8"/><circle cx="17.5" cy="6" r="2.5" fill="#3468E8"/><circle cx="21" cy="11" r="2.2" fill="#3468E8"/><path d="M4 19c-1-4 4-7 7-7s8 4 7 7c-1 4-4 1-7 1s-6 3-7-1Z" fill="#3468E8"/>'
};
// The three editors share docs.google.com, but retain their own product marks.
for(const [name,color,detail] of [
 ['google-docs','#4285F4','<path d="M7 11h10M7 14h10M7 17h7" stroke="white" stroke-width="1.5"/>'],
 ['google-sheets','#0F9D58','<path d="M7 11h10v7H7zM7 14.5h10M11 11v7" fill="none" stroke="white" stroke-width="1.3"/>'],
 ['google-slides','#F4B400','<rect x="6.5" y="10" width="11" height="8" rx=".8" fill="white"/><rect x="8" y="11.5" width="8" height="5" fill="#F4B400"/>']
]) brands[name]=`<path d="M5 1h9l5 5v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1Z" fill="${color}"/><path d="M14 1v5h5" fill="white" opacity=".35"/>${detail}`;
export const productVectors=new Set(['google-docs','google-sheets','google-slides']);
export function icon(name) {
 const body=brands[name]||strokes[name]||strokes.globe;
 return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" ${brands[name]?'': 'fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"'}>${body}</svg>`;
}
export function websiteIcon(url) {
 try { const host=new URL(url).hostname.replace(/^www\./,'');return ({'mail.ionacs.com':'mail','google.com':'google','github.com':'github','youtube.com':'youtube','bing.com':'bing'})[host]||'globe'; } catch { return 'globe'; }
}
