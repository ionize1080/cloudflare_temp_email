import { test } from 'node:test';
import assert from 'node:assert/strict';
import { websites, suggestWebsites, matchWebsite } from '../public/catalog.mjs';
test('directory contains 100 distinct products with secure destinations',()=>{
 assert.equal(websites.length,100);assert.equal(new Set(websites.map(s=>s.id)).size,100);
 for(const site of websites)assert.equal(new URL(site.url).protocol,'https:');
});
test('product queries prioritize their exact product; company queries include related products',()=>{
 assert.equal(suggestWebsites('YouTube')[0].id,'youtube');
 assert.equal(suggestWebsites('油管')[0].id,'youtube');
 assert.equal(suggestWebsites('Google')[0].id,'google');
 assert.ok(suggestWebsites('谷歌').some(s=>s.id==='youtube'));
 assert.ok(suggestWebsites('微软').some(s=>s.id==='bing'));
 assert.equal(suggestWebsites('mail.qq.com')[0].id,'qq-mail');
 assert.equal(suggestWebsites('docs.google.com/spreadsheets')[0].id,'google-sheets');
 assert.deepEqual(suggestWebsites('不存在的网站abcdef'),[]);
});
test('icons resolve by product subdomain and path, without matching unrelated lookalike domains',()=>{
 assert.equal(matchWebsite('https://www.youtube.com/watch?v=x').id,'youtube');
 assert.equal(matchWebsite('https://docs.google.com/spreadsheets/d/test').id,'google-sheets');
 assert.equal(matchWebsite('https://docs.google.com/document/d/test').id,'google-docs');
 assert.equal(matchWebsite('https://mail.google.com/mail/u/0/').id,'gmail');
 assert.equal(matchWebsite('https://v.qq.com/').id,'tencent-video');
 assert.equal(matchWebsite('https://google.com.evil.example/'),null);
});
