// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).
// Optional Chromium integration test. No public map/routing data or real accounts are used.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const root = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const baseline = process.argv.includes('--baseline');
const output = new URL('../test-results/offline-shell/', import.meta.url);
const fixtures = new URL('../.wrangler/offline-shell-fixtures/', import.meta.url);
await mkdir(output, {recursive:true});
await mkdir(fixtures, {recursive:true});
const assets = new Map();
for (const filename of ['maplibre-gl.js', 'maplibre-gl.css']) {
  const url = `https://unpkg.com/maplibre-gl@4.7.1/dist/${filename}`;
  const local = new URL(filename, fixtures);
  let body;
  try { body = await readFile(local); } catch {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    assert.equal(response.ok, true, `download fixed MapLibre asset ${filename}`);
    body = Buffer.from(await response.arrayBuffer());
    await writeFile(local, body);
  }
  assets.set(url, {body, contentType:filename.endsWith('.js')?'text/javascript':'text/css'});
}
const requests = [];
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  requests.push(path);
  if (path.startsWith('/api/')) {
    const data = path === '/api/me' ? {user:null,stats:null,tester:false} : path === '/api/presence' ? {admitted:true,active:1,max:50,waiting:0} :
      path === '/api/reports' ? {reports:[]} : path === '/api/chargers' ? {chargers:[]} : {saved:[],recent:[]};
    res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'}); res.end(JSON.stringify(data)); return;
  }
  const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    const body = baseline && path === '/sw.js' ? execFileSync('git',['show','134045a:public/sw.js'],{cwd:root}) : await readFile(file);
    res.writeHead(200, {'content-type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png'})[extname(file)]||'application/octet-stream','cache-control':'no-store'});
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']});
  const context = await browser.newContext({viewport:{width:375,height:812},serviceWorkers:'allow'});
  const external = [], workerAssets = [];
  let networkOffline = false;
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(origin)) return route.continue();
    if (assets.has(url)) {
      if (networkOffline) return route.abort('internetdisconnected');
      if (route.request().serviceWorker()) workerAssets.push(url);
      return route.fulfill({status:200,headers:{'access-control-allow-origin':'*'},...assets.get(url)});
    }
    external.push(url);
    return route.abort();
  });
  await context.addInitScript(() => {
    localStorage.setItem('a2b.welcomed', 'true');
    localStorage.setItem('a2b.settings', JSON.stringify({theme:'day'}));
    Object.defineProperty(navigator,'geolocation',{value:{watchPosition(){return 0;},clearWatch(){}}});
    let library;
    Object.defineProperty(window,'maplibregl',{configurable:true,get(){return library;},set(value){
      library=value;
      const RealMap=value.Map;
      value.Map=class extends RealMap { constructor(options) {
        super({...options,style:{version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#e7e5e2'}}]}});
        window.__fixtureMap=this;
      }};
    }});
  });
  const first = await context.newPage(), initialErrors = [];
  first.on('pageerror', error => initialErrors.push(error.message));
  await first.goto(origin);
  await first.waitForFunction(() => window.__fixtureMap?.loaded(), null, {timeout:15000});
  await first.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, {timeout:15_000});
  const installed = await first.evaluate(async () => {
    const names=await caches.keys(), data={};
    for (const name of names) data[name]=(await (await caches.open(name)).keys()).map(request=>request.url);
    return data;
  });
  const shellName=Object.keys(installed).find(name=>/^a2b-v\d+$/.test(name));
  assert.ok(shellName, 'real SW installation creates the shell cache');
  const shell=installed[shellName].map(url=>new URL(url).pathname);
  const missing=['/route-preview.js','/probe.js'].filter(path=>!shell.includes(path));
  assert.equal(missing.length,baseline?2:0);
  const maps=installed['a2b-maps-v1']??[];
  assert.equal(maps.filter(url=>assets.has(url)).length,2,'SW install cached real MapLibre JS and CSS');
  assert.deepEqual(initialErrors,[]);
  const cdp=await context.newCDPSession(first);
  await cdp.send('Network.enable');
  await cdp.send('Network.clearBrowserCache');
  await cdp.detach();
  await first.close();
  await new Promise(resolve=>server.close(resolve)); // no origin server remains available to rescue a cache miss
  networkOffline = true;
  await context.setOffline(true);
  const cold=await context.newPage(), coldErrors=[], coldResponses=[], coldFailed=[];
  cold.on('pageerror',error=>coldErrors.push(error.message));
  cold.on('response',response=>coldResponses.push({url:response.url(),status:response.status(),fromServiceWorker:response.fromServiceWorker()}));
  cold.on('requestfailed',request=>coldFailed.push({url:request.url(),error:request.failure()?.errorText}));
  const requestsBefore=requests.length;
  await cold.goto(origin,{waitUntil:'load'});
  let booted=false;
  try { await cold.waitForFunction(()=>Boolean(window.__fixtureMap?.loaded()&&document.getElementById('btn-menu').onclick),null,{timeout:baseline?5000:15000}); booted=true; } catch {}
  const localScripts=coldResponses.filter(r=>r.url.startsWith(origin)&&new URL(r.url).pathname.endsWith('.js'));
  const result={mode:baseline?'baseline-134045a':'fixed',cache:shellName,shellFiles:shell.length,missingImports:missing,
    httpCacheCleared:true,originalPageClosed:true,networkOffline:true,booted,localScriptResponses:localScripts.length,
    allLocalScriptsFromSW:localScripts.every(r=>r.fromServiceWorker),mapAssetsCached:maps.filter(url=>assets.has(url)),
    mapAssetResponses:coldResponses.filter(r=>assets.has(r.url)),
    workerAssetFetches:workerAssets.length,externalProviderRequestsBlocked:external,coldErrors,coldFailed,
    localServerRequestsAfterOffline:requests.length-requestsBefore};
  if (baseline) {
    assert.equal(booted,false,'old shell must fail a cold offline import');
    assert.ok(coldFailed.some(r=>/\/(route-preview|probe)\.js$/.test(r.url)), 'missing import fails offline');
  } else {
    assert.equal(booted,true,'new cold page runs the actual app and real MapLibre');
    assert.deepEqual(coldErrors,[]);
    assert.deepEqual(localScripts.map(r=>new URL(r.url).pathname).sort(),shell.filter(p=>p.endsWith('.js')).sort(),
      'every precached frontend module loaded in the new page');
    assert.ok(localScripts.every(r=>r.fromServiceWorker));
    assert.equal(result.mapAssetResponses.length,2);
    assert.ok(result.mapAssetResponses.every(r=>r.fromServiceWorker),'real MapLibre assets also come from SW, with fixture routing disabled offline');
    assert.equal(requests.length,requestsBefore,'no local network requests while offline');
    await cold.locator('#btn-menu').click();
    assert.equal(await cold.locator('#menu').isVisible(),true,'actual app UI handlers work after cold boot');
    await cold.screenshot({path:fileURLToPath(new URL('cold-offline-mobile.png',output))});
  }
  await writeFile(new URL(baseline?'baseline.json':'fixed.json',output),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  if (server.listening) await new Promise(resolve=>server.close(resolve));
}
