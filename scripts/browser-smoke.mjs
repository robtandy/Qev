// Real Chromium + real Qwasm, using only the installed LibreQuake demo.
// --model runs Laya; --explore runs levels; --compare evaluates choice/noul; --assistance adds a short aids-on/off trial.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { makeServer, root } from "./serve.mjs";
import { DEMO } from "../src/demo-manifest.js";
import { compareDecisions } from "./compare-decisions.mjs";
import { beginAudioChecks, checkAudioPlayback } from "./browser-audio.mjs";
import { checkModelSelection } from "./browser-model-selection.mjs";
import { checkPriorities } from "./browser-priorities.mjs";
import { checkAssistance, runAssistanceTrials } from "./browser-assistance.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 30_000) {
  const start = Date.now(); let error;
  while (Date.now() - start < timeout) {
    try { const value = await fn(); if (value) return value; } catch (e) { error = e; }
    await sleep(100);
  }
  throw error || new Error("Timed out waiting for browser state.");
}
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (process.argv.slice(2).some((arg) => !["--model", "--explore", "--compare", "--assistance"].includes(arg))) throw new Error("Usage: node scripts/browser-smoke.mjs [--model] [--explore] [--compare] [--assistance]. Model/trial flags load Laya. Install the demo with npm run setup:demo first.");
const explore = process.argv.includes("--explore");
const compare = process.argv.includes("--compare");
const assistanceTrials = process.argv.includes("--assistance");
const runModel = explore || compare || assistanceTrials || process.argv.includes("--model");
await mkdir(resolve(root, "build/browser-profile"), { recursive: true });
const server = makeServer();
await new Promise((r) => server.listen(8091, "127.0.0.1", r));
// Silence the test browser's output, not the app/mixer: audio regression checks still inspect real samples.
const chrome = spawn(chromePath, ["--headless=new", "--enable-automation", "--mute-audio", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--enable-unsafe-webgpu", "--autoplay-policy=document-user-activation-required", `--user-data-dir=${root}/build/browser-profile`, "--remote-debugging-port=9226", "about:blank"], { stdio: "ignore" });
let ws, evaluate;
const errors = [], requests = [], dragEvents = [];
try {
  const page = await until(async () => (await (await fetch("http://127.0.0.1:9226/json/list")).json()).find((p) => p.type === "page"));
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, reject) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  let sequence = 0; const pending = new Map();
  ws.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const p = pending.get(message.id); pending.delete(message.id);
      if (message.error) p.reject(new Error(JSON.stringify(message.error))); else p.resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
    else if (message.method === "Network.requestWillBeSent") requests.push(message.params.request.url);
    else if (message.method === "Input.dragIntercepted") dragEvents.push(message.params.data);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const check = async (label, expression) => {
    assert.equal(await evaluate(`(async () => { ${expression} })()`), true, label);
    console.log(`PASS ${label}`);
  };
  assert.ok((await call("Browser.getBrowserCommandLine")).arguments.includes("--mute-audio"), "Test browser must have audio output muted before running any checks.");
  console.log("PASS test browser audio output is muted (--mute-audio)");
  await call("Runtime.enable"); await call("Page.enable"); await call("Network.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  const navigate = async (path) => {
    const url = `http://127.0.0.1:8091${path}`;
    await call("Page.navigate", { url });
    await until(() => evaluate(`location.href === ${JSON.stringify(url)} && document.readyState !== 'loading' && !!window.qev`));
  };
  const checkDemoOnly = (label) => check(label, `
    return !document.querySelector('input[type="file"], #manual-import, #asset-mode-link, #launch, #skill, #sound');
  `);
  await call("Network.setBlockedURLs", { urls: ["http://127.0.0.1:8091/demo/pak1.pak"] });
  await navigate("/");
  await until(() => evaluate("!document.querySelector('#retry-demo').hidden"));
  await checkDemoOnly("failed loading does not expose a manual-import fallback");
  await check("an interrupted download offers setup/reload guidance and never boots partial data", `
    return !qev.engine && !qev.model && document.querySelector('#step').disabled && document.querySelector('#auto').disabled && document.querySelector('#map').disabled &&
      document.querySelector('#asset-status').textContent.includes('pak1.pak') &&
      document.querySelector('#asset-status').textContent.includes('npm run setup:demo') &&
      document.querySelector('#retry-demo').getAttribute('href') === '/';
  `);
  await check("priorities can be changed before the engine or a model has loaded", `
    document.querySelector('[data-priority=get-supplies] [data-move=up]').click();
    return !qev.engine && !qev.model && qev.priorityOrder[0]==='get-supplies' &&
      document.querySelector('#priorities').firstElementChild.dataset.priority==='get-supplies' && document.querySelector('#auto').disabled;
  `);
  await call("Network.setBlockedURLs", { urls: [] });
  await check("real legacy startup errors surface immediately with demo repair guidance", `
    const {Engine} = await import('/src/engine.js');
    const response = await fetch('/demo/pak0.pak');
    if (!response.ok) throw new Error('Demo fixture unavailable');
    const bytes = new Uint8Array(await response.arrayBuffer());
    const start = performance.now();
    try {
      await Engine.start({canvas:document.querySelector('#game'),data:{files:[{name:'pak0.pak',bytes}],maps:['lq_e0m1']},map:'lq_e0m1'});
      return false;
    } catch (error) {
      return /registered version/.test(error.message) && /npm run setup:demo/.test(error.message) && performance.now()-start < 10000;
    }
  `);
  requests.length = 0;
  await evaluate("document.querySelector('#retry-demo').click()");
  await until(() => evaluate("!!window.qev?.engine"), 45_000);
  await check("Reload demo recovers to the automatic paused level and default priorities", `return qev.engine.snapshot().paused && qev.priorityOrder.join(',')==='avoid-harm,get-supplies,handle-threats,explore' && document.querySelector('#retry-demo').hidden && document.querySelector('#error').hidden;`);
  await checkDemoOnly("the loaded demo has no file picker or import-mode controls");
  // A bookmarked URL from the old UI must not resurrect an import path or disable startup.
  await navigate("/?assets=manual");
  await until(() => evaluate("!!qev.engine"), 45_000);
  await checkDemoOnly("legacy asset-mode URLs cannot re-enable manual import");
  await check("legacy URLs still start the same demo", `return qev.engine.snapshot().paused && qev.engine.snapshot().map === '${DEMO.map}' && !qev.model;`);
  await navigate("/");
  await check("model downloading waits for an explicit selection", `return !qev.model && document.querySelector('#step').disabled;`);
  await until(() => evaluate("!!qev.engine"), 45_000);
  console.log("Map:", await evaluate("document.querySelector('#map').value"));
  await check("the demo starts paused with all three matching PAKs", `
    const files = qev.engine.module.FS.readdir('/id1');
    return qev.engine.snapshot().paused && !qev.model && document.querySelector('#map').value === '${DEMO.map}' &&
      ['pak0.pak','pak1.pak','pak2.pak'].every((name) => files.includes(name));
  `);
  assert.deepEqual(requests.filter((url) => /^https?:/.test(url) && !url.startsWith('http://127.0.0.1:8091/')), [], "automatic game startup makes no remote/model requests");
  await beginAudioChecks({ check });
  await check("the steel QEV logo loads beside the exact tagline and survives SDL title initialization", `
    const header=document.querySelector('.masthead'), logo=header.querySelector('.brand-logo');
    await logo.decode();
    const response=await fetch(logo.currentSrc,{method:'HEAD'});
    return logo.alt==='QEV' && new URL(logo.currentSrc).pathname==='/brand/qev-logo.svg' &&
      logo.naturalWidth===1200 && logo.naturalHeight===560 && response.headers.get('content-type')==='image/svg+xml' &&
      header.querySelector('h1').textContent==='quake played by a local decision model' &&
      document.title==='QEV - quake played by a local decision model' && !header.querySelector('.mark, .badge') &&
      !/kevala|Local experiment|software renderer/i.test(header.textContent);
  `);
  const checkBrandLayout=label=>check(label, `
    const header=document.querySelector('.masthead').getBoundingClientRect(), logo=document.querySelector('.brand-logo').getBoundingClientRect();
    const heading=document.querySelector('.brand h1'), text=heading.getBoundingClientRect(), links=document.querySelector('.header-links').getBoundingClientRect();
    if(logo.width<90 || logo.height<40 || text.left<logo.right+4 || text.right>links.left-4 ||
      Math.ceil(text.width)<heading.scrollWidth || links.right>innerWidth ||
      Math.max(logo.bottom,text.bottom,links.bottom)>header.bottom || document.documentElement.scrollWidth>innerWidth)
      throw new Error('Brand layout: '+JSON.stringify({header:header.toJSON(),logo:logo.toJSON(),text:text.toJSON(),links:links.toJSON(),viewport:[innerWidth,innerHeight]}));
    return true;
  `);
  await checkBrandLayout('the tagline stays to the right of the steel logo without overlapping project links');
  await check("the upper-right header links to the actual GitHub repo and reserves an X icon without a fake URL", `
    const links=document.querySelector('.header-links'), repo=links.querySelector('#repo-link'), post=links.querySelector('#x-post-link');
    return repo.href==='https://github.com/robtandy/Qev' && repo.target==='_blank' && repo.relList.contains('noopener') &&
      post.textContent==='𝕏' && post.getAttribute('aria-disabled')==='true' && !post.hasAttribute('href') &&
      links.getBoundingClientRect().left>document.querySelector('.brand').getBoundingClientRect().right;
  `);
  await check("the footer credits all five projects with their actual links", `
    const footer=document.querySelector('footer.credits'), links=[...footer.querySelectorAll('a')];
    return footer.textContent.includes('Thanks to:') &&
      JSON.stringify(links.map(a=>[a.textContent,a.href]))===JSON.stringify([
        ['kev','https://github.com/jaredpalmer/kev'],['laya','https://huggingface.co/convaiinnovations/laya'],
        ['kevala','https://github.com/bvolpato/kevala'],['qwasm','https://github.com/GMH-Code/Qwasm'],
        ['libre quake','https://github.com/lavenderdotpet/LibreQuake']]) &&
      links.every(a=>a.target==='_blank' && a.relList.contains('noopener'));
  `);
  await check("map 6 starts on Hard in both the actual engine and the selector", `
    return qev.engine.snapshot().map === 'lq_e0m6' && qev.engine.snapshot().difficulty === 2 &&
      document.querySelector('#map').value === 'lq_e0m6' && document.querySelector('#difficulty').value === '2' && !document.querySelector('#difficulty').disabled &&
      [...document.querySelector('#difficulty').options].map(o=>o.value).join(',') === '0,1,2,3' && !document.querySelector('.intro');
  `);
  await checkModelSelection({ evaluate, check, until });
  assert.deepEqual(requests.filter(url=>/^https?:/.test(url) && !url.startsWith('http://127.0.0.1:8091/')),[], 'startup, Start without a choice, and the fake loading checks must not fetch real model weights');
  await call("Emulation.setDeviceMetricsOverride", { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  await sleep(100);
  await checkBrandLayout('the steel logo and tagline fit the laptop header');
  await check("the full-size game fits above the fold beside two narrower priorities/decisions columns", `
    const r=document.querySelector('.screen').getBoundingClientRect(), side=document.querySelector('.inspector').getBoundingClientRect();
    const priorities=document.querySelector('.priority-column').getBoundingClientRect(), list=document.querySelector('#priorities');
    if(scrollY!==0 || r.height<500 || r.width<800 || r.bottom>innerHeight ||
      priorities.left<r.right || side.left<priorities.right || priorities.width>220 || side.width>280 ||
      Math.abs(priorities.top-r.top)>1 || Math.abs(side.top-r.top)>1 ||
      priorities.bottom>r.bottom+1 || side.bottom>r.bottom+1 || list.scrollHeight>list.clientHeight+1 ||
      document.documentElement.scrollWidth>innerWidth) throw new Error('Laptop layout: '+JSON.stringify({screen:r.toJSON(),priorities:priorities.toJSON(),inspector:side.toJSON(),viewport:[innerWidth,innerHeight],scrollY,setup:document.querySelector('.setup').getBoundingClientRect().toJSON(),playback:document.querySelector('.playback').getBoundingClientRect().toJSON()}));
    return true;
  `);
  const compactDesktop = await call("Page.captureScreenshot", {format:'png'});
  await writeFile(resolve(root,'build/qev-cards-empty-desktop.png'),Buffer.from(compactDesktop.data,'base64'));
  await call("Emulation.setDeviceMetricsOverride", { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(100);
  await check('tablet layout keeps priorities and decisions adjacent beneath the complete game', `
    const game=document.querySelector('.screen').getBoundingClientRect(), priorities=document.querySelector('.priority-column').getBoundingClientRect(), decisions=document.querySelector('.inspector').getBoundingClientRect();
    return game.bottom<=innerHeight && priorities.top>=game.bottom && Math.abs(priorities.top-decisions.top)<1 &&
      decisions.left>=priorities.right && document.documentElement.scrollWidth<=innerWidth;
  `);
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(100);
  await checkBrandLayout('the mobile tagline wraps beside the logo rather than covering it or the links');
  await check("compact setup leaves the complete mobile game above the fold", `
    const brand=document.querySelector('.brand').getBoundingClientRect(), links=document.querySelector('.header-links').getBoundingClientRect();
    if(brand.right>links.left || links.right>innerWidth) throw new Error('Mobile header overlap');
    const r=document.querySelector('.screen').getBoundingClientRect();
    if(scrollY!==0 || r.bottom>innerHeight || document.documentElement.scrollWidth>innerWidth) throw new Error('Mobile layout: '+JSON.stringify({screen:r.toJSON(),viewport:[innerWidth,innerHeight],scrollY,setup:document.querySelector('.setup').getBoundingClientRect().toJSON(),playback:document.querySelector('.playback').getBoundingClientRect().toJSON()}));
    return true;
  `);
  await check('phone layout stacks the side panels with usable touch reorder buttons and no overflow', `
    const game=document.querySelector('.screen').getBoundingClientRect(), priorities=document.querySelector('.priority-column').getBoundingClientRect(), decisions=document.querySelector('.inspector').getBoundingClientRect();
    return priorities.top>=game.bottom && decisions.top>=priorities.bottom &&
      [...document.querySelectorAll('.priority-controls button')].every(button=>{const r=button.getBoundingClientRect();return r.width>=32 && r.height>=32;}) &&
      document.documentElement.scrollWidth<=innerWidth;
  `);
  const compactMobile = await call("Page.captureScreenshot", {format:'png'});
  await writeFile(resolve(root,'build/qev-cards-empty-mobile.png'),Buffer.from(compactMobile.data,'base64'));
  await call("Emulation.setDeviceMetricsOverride", { width: 320, height: 740, deviceScaleFactor: 1, mobile: true });
  await sleep(100);
  await checkBrandLayout('the full logo and tagline also fit a narrow 320px viewport');
  const narrowHeader=await call('Page.captureScreenshot',{format:'png'});
  await writeFile(resolve(root,'build/qev-steel-header-narrow.png'),Buffer.from(narrowHeader.data,'base64'));
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  const initial = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(resolve(root, "build/qev-demo-start.png"), Buffer.from(initial.data, "base64"));
  await check("real Quake starts alive and freezes the whole world", `
    window.beforePause = qev.engine.snapshot();
    await new Promise((r) => setTimeout(r, 400));
    const now = qev.engine.snapshot();
    return now.ready && now.alive && now.paused && now.tick === beforePause.tick && JSON.stringify(now.player.position) === JSON.stringify(beforePause.player.position);
  `);
  console.log("Initial full-level snapshot:", await evaluate("qev.engine.snapshot()"));
  await checkPriorities({ evaluate, check, until, call, dragEvents });
  assert.deepEqual(requests.filter(url=>/^https?:/.test(url) && !url.startsWith('http://127.0.0.1:8091/')),[], 'reordering priorities and inspecting fake decisions must not download a model');
  await check("only the game remains in its column; the old panels, picker, and human button are removed", `
    const column=document.querySelector('.game-column');
    return column.children.length===1 && column.firstElementChild.className==='screen' &&
      !document.querySelector('#history, #human, #stats, #navigation, #observation, #engine-log, .screen-label') &&
      !!document.querySelector('#decisions') && document.querySelector('#map').options.length >= 8 &&
      typeof qev.engine.snapshot().player.silverKey === 'boolean' && qev.agent.navigation.summary(qev.engine.snapshot()).goalComplete === false;
  `);
  await check("playback exposes exactly Start, Stop, and Step, with no restart/score/frame buttons", `
    return [...document.querySelectorAll('.controls button')].map(b=>b.textContent.trim()).join(',')==='Start,Stop,Step' &&
      !document.querySelector('#restart, #score, #frame') && document.querySelector('#auto').getAttribute('aria-pressed')==='false';
  `);
  await check("native difficulty/map validation fails closed without changing the current world", `
    const s=qev.engine.snapshot(), m=qev.engine.module;
    return m.ccall('qev_new_game','number',['string','number'],['lq_e0m6',4])===0 &&
      m.ccall('qev_new_game','number',['string','number'],['lq_e0m6',-1])===0 &&
      m.ccall('qev_new_game','number',['string','number'],['lq_e0m6;kill',0])===0 && qev.engine.snapshot().epoch===s.epoch;
  `);
  for (const difficulty of [1,2,3,0]) {
    const epoch=await evaluate('qev.engine.snapshot().epoch');
    await evaluate(`document.querySelector('#difficulty').value='${difficulty}'; document.querySelector('#difficulty').dispatchEvent(new Event('change',{bubbles:true}))`);
    await until(()=>evaluate(`qev.engine.snapshot().ready && qev.engine.snapshot().epoch!==${epoch} && qev.engine.snapshot().difficulty===${difficulty} && !document.querySelector('#map').disabled`));
    await check('selecting difficulty '+difficulty+' immediately reloads the engine stopped', `return qev.engine.snapshot().paused && qev.engine.snapshot().map==='lq_e0m6' && qev.playMode==='inspection';`);
  }
  // Use Quake's actual console/key binding; no extra kill/cheat bridge is added to the app.
  const pressKeys = async (keys) => {
    await evaluate("document.querySelector('#game').focus({preventScroll:true})");
    const events=[];
    for(const [key,code,windowsVirtualKeyCode,shifted=false] of keys) {
      if(shifted) events.push(call('Input.dispatchKeyEvent',{type:'keyDown',key:'Shift',code:'ShiftLeft',windowsVirtualKeyCode:16,modifiers:8}));
      events.push(call('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode,modifiers:shifted?8:0,...(key.length===1?{text:key}:key==='Enter'?{text:String.fromCharCode(13)}:{})}));
      events.push(call('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode,modifiers:shifted?8:0}));
      if(shifted) events.push(call('Input.dispatchKeyEvent',{type:'keyUp',key:'Shift',code:'ShiftLeft',windowsVirtualKeyCode:16}));
    }
    await Promise.all(events);
  };
  const bindKillForTest = async () => {
    await pressKeys([[String.fromCharCode(96),'Backquote',192]]); await sleep(120);
    // LibreQuake's `kill` command restarts immediately inside QuakeC. Zero health instead
    // exercises the native death signal and the app's ordinary damage/death recovery path.
    const keys=[...'bind v "give h 0"'].map(c=>c==='"'?[c,'Quote',222,true]:[c,c===' '?'Space':/[0-9]/.test(c)?'Digit'+c:'Key'+c.toUpperCase(),c===' '?32:c.toUpperCase().charCodeAt(0)]);
    await pressKeys([...keys,['Enter','Enter',13]]); await sleep(120);
    await pressKeys([[String.fromCharCode(96),'Backquote',192]]); await sleep(120);
  };
  const killPlayerViaConsole = () => pressKeys([['v','KeyV',86]]);
  // Use the explicit small arena for deterministic combat/input/race regression checks.
  await evaluate("document.querySelector('#map').value='qev_encounter'; document.querySelector('#map').dispatchEvent(new Event('change',{bubbles:true}))");
  await until(() => evaluate("qev.engine.snapshot().ready && qev.engine.snapshot().paused && qev.engine.snapshot().map==='qev_encounter' && !document.querySelector('#map').disabled"));
  await check("Step frame advances exactly one simulation tick", `
    const before = qev.engine.snapshot(); await qev.engine.frame();
    const after = qev.engine.snapshot();
    return after.tick === before.tick + 1 && after.paused && after.remaining === 0;
  `);
  await check("engine bridge rejects stale ticks, non-finite input, and unbounded leases", `
    const s = qev.engine.snapshot(), m = qev.engine.module;
    return m._qev_action(s.epoch, s.tick - 1, 0, 0, -1, 0, 0, 0, 0, 12) === 0 &&
      m._qev_action(s.epoch, s.tick, NaN, 0, -1, 0, 0, 0, 0, 12) === 0 &&
      m._qev_action(s.epoch, s.tick, 0, 0, -1, 0, 0, 0, 0, 999) === 0;
  `);
  await check("gravity can settle the real player onto supported ground before movement tests", `
    for (let i = 0; i < 90 && !qev.engine.snapshot().player.grounded; i++) await qev.engine.frame();
    return qev.engine.snapshot().player.grounded && qev.engine.snapshot().paused;
  `);
  await checkAudioPlayback({ evaluate, check, call, until });
  await checkAssistance({ evaluate, check, until, bindKillForTest, killPlayerViaConsole });
  await evaluate(`
    window.originalModel = qev.agent.getModel;
    window.mockCalls = [];
    qev.agent.getModel = () => window.mockModel;
    window.mockModel = {info: {model: 'mock-control-test', backend: 'test'}, decideMany(requests) {
      return new Promise((resolve) => mockCalls.push({requests, resolve, eligible: structuredClone(qev.agent.current.eligible)}));
    }};
    window.mockResponses = (c, selected) => {
      const keys = Object.keys(c.requests[0].questions.action.criteria);
      if(selected < 0) selected = 0;
      return [{answers:{action:{type:'choice',choice:keys[selected],probabilities:Object.fromEntries(keys.map((key,i)=>[key,keys.length===1?1:i===selected?0.9:0.1/(keys.length-1)]))}},raw_probabilities:{action:[0.123456789,0.876543211]},extra:'<img src=x onerror="window.injected=true">'}];
    };
    window.resolveMock = async () => {
      const c = mockCalls.at(-1);
      const move = c.eligible.findIndex((c) => c.params.dx || c.params.dy);
      c.responses = mockResponses(c, move);
      c.resolve(c.responses);
      await new Promise((r) => setTimeout(r, 30));
    };
  `);
  // Frozen scoring remains a diagnostic API for protocol checks; the public Step combines it with execution.
  await until(() => evaluate("!document.querySelector('#step').disabled"));
  await evaluate("void qev.score()");
  await check("scoring captures the complete exact request while simulation time remains frozen", `
    const before = qev.engine.snapshot();
    await new Promise((r) => setTimeout(r, 300));
    const card=document.querySelector('.decision-card');
    return qev.engine.snapshot().tick === before.tick && qev.agent.busy && document.querySelector('#step').disabled &&
      card.querySelector('.decision-status').hidden && card.getAttribute('aria-busy')==='true' &&
      JSON.stringify(JSON.parse(card.querySelector('[data-payload="request"]').textContent)) === JSON.stringify(mockCalls[0].requests);
  `);
  await evaluate("resolveMock()");
  await check("the actual full response is inspectable without precision loss or HTML execution", `
    const card=document.querySelector('.decision-card');
    return qev.agent.current.status === 'scored' && !window.injected && !card.querySelector('img') &&
      card.querySelector('.decision-status').textContent==='Accepted' && !card.querySelector('.decision-status').hidden &&
      JSON.stringify(JSON.parse(card.querySelector('[data-payload="response"]').textContent)) === JSON.stringify(mockCalls[0].responses);
  `);
  await check("one shared state offers every eligible action together and preserves the SDK choice", `
    const r = qev.agent.current, input = r.requests[0];
    return r.objective==='SURVIVE' && r.objectives.length===4 && input.state.startsWith('Goal: SURVIVE') &&
      input.questions.action.instructions.includes('SURVIVE') &&
      r.decisionFormat === 'choice' && r.requests.length === 1 && input.questions.action.type === 'choice' &&
      JSON.stringify(Object.keys(input.questions.action.criteria)) === JSON.stringify(r.eligible.map(c=>c.id)) &&
      r.eligible[r.selectedIndex].id === r.responses[0].answers.action.choice &&
      document.querySelector('.decision-card [data-payload="state"]').textContent===input.state &&
      document.querySelector('.decision-card .candidates').textContent.includes('Request [0]');
  `);
  await check("each card puts the exact model state in a collapsed arrow disclosure above the weighted actions", `
    const card=document.querySelector('.decision-card');
    card.querySelector('.decision-summary').click();
    const state=card.querySelector('[data-section="state"]'), summary=state.querySelector('summary'), choices=card.querySelector('.candidates');
    return card.querySelector('.decision-details').open && !state.open &&
      summary.textContent==='State sent to model' && getComputedStyle(summary).display==='list-item' &&
      getComputedStyle(summary).listStyleType!=='none' && !card.querySelector('.decision-note') &&
      !card.textContent.includes('Uses answers.action.choice, including rounded ties.') &&
      state.getBoundingClientRect().bottom<=choices.getBoundingClientRect().top &&
      state.querySelector('pre').textContent===qev.agent.current.requests[0].state;
  `);
  const collapsedState=await call('Page.captureScreenshot',{format:'png'});
  await writeFile(resolve(root,'build/qev-state-panel-collapsed.png'),Buffer.from(collapsedState.data,'base64'));
  await check("the state arrow expands and its Copy button uses the exact submitted text", `
    const card=document.querySelector('.decision-card'), state=card.querySelector('[data-section="state"]');
    state.querySelector('summary').click();
    const original=navigator.clipboard.writeText;let copied;
    navigator.clipboard.writeText=async text=>{copied=text;};
    try {
      state.querySelector('[data-copy="state"]').click();await new Promise(r=>setTimeout(r,0));
      return state.open && state.querySelector('pre').getBoundingClientRect().height>0 &&
        copied===qev.agent.current.requests[0].state && state.querySelector('pre').textContent===copied && !state.querySelector('img');
    } finally {navigator.clipboard.writeText=original;}
  `);
  const expandedState=await call('Page.captureScreenshot',{format:'png'});
  await writeFile(resolve(root,'build/qev-state-panel-expanded.png'),Buffer.from(expandedState.data,'base64'));
  await evaluate("document.querySelector('.decision-card .decision-details').open=false");
  await check("selected action executes exactly twelve ticks and returns to a stable pause", `
    const before = qev.engine.snapshot(); await qev.step();
    const after = qev.engine.snapshot(); await new Promise((r) => setTimeout(r, 300));
    return after.tick - before.tick === 12 && after.paused && qev.agent.current.status === 'executed' && qev.engine.snapshot().tick === after.tick;
  `);
  console.log("Executed action:", await evaluate("({id:qev.agent.current.eligible[qev.agent.current.selectedIndex].id,before:qev.agent.current.before.player.position,after:qev.agent.current.after.player.position})"));
  await check("a valid movement primitive changes position in the actual engine", `
    const r = qev.agent.current;
    return r.eligible[r.selectedIndex].params.dx !== 0 || r.eligible[r.selectedIndex].params.dy !== 0 ? Math.hypot(...r.after.player.position.map((n,i) => n-r.before.player.position[i])) > 1 : false;
  `);
  if (await evaluate("qev.agent.current.eligible[qev.agent.current.selectedIndex].params.fire")) {
    await check("tracking and firing spends ammunition against a genuinely visible engine target", `
      return qev.agent.current.before.enemies.length > 0 && qev.agent.current.after.player.ammo < qev.agent.current.before.player.ammo;
    `);
  }
  await until(()=>evaluate("!document.querySelector('#step').disabled"));
  await evaluate("qev.agent.invalidate();window.beforeSingleStep=qev.engine.snapshot();window.stepSequence=qev.agent.sequence;document.querySelector('#step').click()");
  await until(()=>evaluate('qev.agent.busy'));
  await check("Step automatically scores while stopped and disables concurrent Start/Step", `
    await new Promise(r=>setTimeout(r,200));
    return qev.engine.snapshot().paused && qev.engine.snapshot().tick===beforeSingleStep.tick &&
      qev.agent.current.status==='scoring' && document.querySelector('#auto').disabled && document.querySelector('#step').disabled && !document.querySelector('#pause').disabled;
  `);
  await evaluate('resolveMock()');
  await until(()=>evaluate("qev.agent.current?.status==='executed' && !document.querySelector('#step').disabled"));
  await check("one Step click runs exactly one model action then stays stopped", `
    await new Promise(r=>setTimeout(r,250));
    return qev.engine.snapshot().paused && qev.engine.snapshot().tick===beforeSingleStep.tick+12 &&
      qev.agent.sequence===stepSequence+1 && qev.playMode==='inspection';
  `);
  await evaluate("document.querySelector('#step').click()");
  await until(()=>evaluate('qev.agent.busy'));
  await check("Stop during Step inference prevents its late reply from moving the player", `
    document.querySelector('#pause').click();const before=qev.engine.snapshot();
    await resolveMock();await new Promise(r=>setTimeout(r,200));
    return qev.engine.snapshot().tick===before.tick && qev.engine.snapshot().paused && !qev.agent.current &&
      qev.agent.history.at(-1).status==='discarded' && document.querySelector('.decision-card .decision-status').textContent==='Rejected';
  `);
  await evaluate("qev.engine.speed(0.1);document.querySelector('#step').click()");
  await until(()=>evaluate('qev.agent.busy'));await evaluate('resolveMock()');
  await until(()=>evaluate('qev.engine.snapshot().remaining>0'));
  await check("Stop also interrupts the action phase of a one-click Step", `
    await new Promise(r=>setTimeout(r,220));document.querySelector('#pause').click();
    const before=qev.engine.snapshot();await new Promise(r=>setTimeout(r,250));qev.engine.speed(1);
    return before.paused && before.remaining===0 && qev.engine.snapshot().tick===before.tick && !qev.agent.busy;
  `);
  await check("Pause during an action cancels remaining ticks and releases inputs", `
    const before = qev.engine.snapshot();
    qev.engine.speed(0.1);
    const p = qev.engine.act({epoch:before.epoch,tick:before.tick,dx:0,dy:0,slot:-1,generation:0,yaw:before.player.yaw+30,pitch:0,fire:false,ticks:12});
    await new Promise((r) => setTimeout(r, 250)); qev.pause();
    const after = await p; qev.engine.speed(1);
    return after.tick - before.tick < 12 && after.remaining === 0 && after.paused;
  `);
  // Unowned input remains an engine regression, not a user-facing play mode.
  await evaluate("qev.engine.play();document.querySelector('#game').focus({preventScroll:true})");
  await until(() => evaluate("!qev.engine.snapshot().paused"));
  const humanTick = await evaluate("qev.engine.snapshot().tick");
  await call("Input.dispatchKeyEvent", {type: "keyDown", code: "KeyW", key: "w", windowsVirtualKeyCode: 87, text: "w"});
  await sleep(120);
  await call("Input.dispatchKeyEvent", {type: "keyUp", code: "KeyW", key: "w", windowsVirtualKeyCode: 87});
  await call("Input.dispatchKeyEvent", {type: "keyDown", code: "KeyP", key: "p", windowsVirtualKeyCode: 80, text: "p"});
  await call("Input.dispatchKeyEvent", {type: "keyUp", code: "KeyP", key: "p", windowsVirtualKeyCode: 80});
  await check("the P shortcut safely pauses unowned engine input without a human-play button", `
    return qev.engine.snapshot().paused && qev.engine.snapshot().tick > ${humanTick};
  `);
  await evaluate("qev.agent.invalidate(); document.querySelector('#step').click()");
  await until(() => evaluate("qev.agent.busy"));
  const oldEpoch = await evaluate("qev.engine.snapshot().epoch");
  await evaluate("document.querySelector('#map').value='lq_e0m6';document.querySelector('#map').dispatchEvent(new Event('change',{bubbles:true}))");
  await until(() => evaluate(`qev.engine.snapshot().ready && qev.engine.snapshot().epoch !== ${oldEpoch} && !document.querySelector('#map').disabled`));
  await evaluate("resolveMock()");
  await check("changing the map immediately loads it stopped and invalidates pending decisions", `
    return qev.engine.snapshot().paused && qev.engine.snapshot().map==='lq_e0m6' && qev.playMode==='inspection' &&
      document.querySelector('#auto').getAttribute('aria-pressed')==='false' && !qev.agent.current && qev.agent.history.at(-1).status === 'discarded';
  `);
  await evaluate("document.querySelector('#map').value='qev_encounter';document.querySelector('#map').dispatchEvent(new Event('change',{bubbles:true}))");
  await until(()=>evaluate("qev.engine.snapshot().map==='qev_encounter' && !document.querySelector('#map').disabled"));
  await until(() => evaluate("!document.querySelector('#auto').disabled"));
  await evaluate("document.querySelector('#auto').click()");
  await until(() => evaluate("qev.agent.busy"));
  await check("stopping real-time Auto during inference never executes its late response", `
    const before = qev.engine.snapshot(); qev.pause(); await resolveMock();
    await new Promise((r) => setTimeout(r, 300));
    return qev.engine.snapshot().tick === before.tick && document.querySelector('#auto').getAttribute('aria-pressed') === 'false';
  `);
  await until(() => evaluate("!qev.agent.busy && !document.querySelector('#auto').disabled"));
  await evaluate("document.querySelector('#auto').click()");await until(()=>evaluate('qev.agent.busy'));
  await evaluate("window.beforeMapChange=qev.agent.current;document.querySelector('#map').value='lq_e0m6';document.querySelector('#map').dispatchEvent(new Event('change',{bubbles:true}))");
  await until(()=>evaluate("qev.engine.snapshot().ready && qev.engine.snapshot().map==='lq_e0m6' && !document.querySelector('#map').disabled"));
  await check("changing maps during Start stops Auto and prevents any late command on the new world", `
    const stopped=qev.engine.snapshot();await resolveMock();await new Promise(r=>setTimeout(r,250));
    return stopped.paused && qev.engine.snapshot().tick===stopped.tick && !qev.engine.snapshot().actionTicksLeft &&
      qev.playMode==='inspection' && beforeMapChange.status==='discarded' && !beforeMapChange.appliedAt &&
      document.querySelector('#auto').textContent==='Start' && document.querySelector('#auto').getAttribute('aria-pressed')==='false';
  `);
  await evaluate("document.querySelector('#map').value='qev_encounter';document.querySelector('#map').dispatchEvent(new Event('change',{bubbles:true}))");
  await until(()=>evaluate("qev.engine.snapshot().map==='qev_encounter' && !document.querySelector('#auto').disabled"));
  await evaluate("document.querySelector('#auto').click()");
  await until(() => evaluate("qev.agent.busy"));
  await check("real-time scoring keeps the actual world advancing rather than freezing it", `
    const before = qev.engine.snapshot();
    await new Promise((r) => setTimeout(r, 400));
    const after = qev.engine.snapshot();
    document.querySelector('#auto').click(); // Start is one-way and disabled while already running.
    return qev.agent.busy && qev.agent.current.mode === 'realtime' && !after.paused && after.owned && after.tick-before.tick >= 15 &&
      document.querySelector('#auto').textContent==='Start' && document.querySelector('#auto').disabled &&
      document.querySelector('#auto').getAttribute('aria-pressed')==='true';
  `);
  await check("Start stays readable while pressed and disabled during real-time play", `
    const button=document.querySelector('#auto'), style=getComputedStyle(button);
    const luminance=color=>{
      const rgb=color.match(/[\\d.]+/g).slice(0,3).map(Number).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4);
      return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
    };
    const text=luminance(style.color), background=luminance(style.backgroundColor);
    const contrast=(Math.max(text,background)+.05)/(Math.min(text,background)+.05);
    return button.textContent==='Start' && button.disabled && button.getAttribute('aria-pressed')==='true' &&
      Number(style.opacity)===1 && contrast>=4.5;
  `);
  await evaluate(`window.resolveScan = async () => {
    const c = mockCalls.at(-1), scan = c.eligible.findIndex((x) => x.id === 'scan-left');
    c.resolve(mockResponses(c, scan));
    await new Promise((r) => setTimeout(r, 30));
  }; resolveScan()`);
  await until(() => evaluate("!!qev.agent.active && qev.agent.busy"));
  await check("the last action keeps executing and turning while the next decision is pending", `
    window.firstLive = qev.agent.active;
    const before = qev.engine.snapshot();
    await new Promise((r) => setTimeout(r, 350));
    const after = qev.engine.snapshot();
    return qev.agent.busy && qev.agent.active === firstLive && !after.paused && after.actionTicksLeft > 0 &&
      after.actionSerial === before.actionSerial && after.actionTicks > before.actionTicks &&
      after.tick-before.tick >= 12 && after.player.yaw !== before.player.yaw;
  `);
  await evaluate("resolveScan()");
  await check("replacement preserves exact observation/apply times and does not pause the engine", `
    return firstLive.status === 'replaced' && firstLive.execution.ticksApplied > 0 &&
      qev.agent.active !== firstLive && qev.agent.active.ageTicksAtApply > 0 && !qev.engine.snapshot().paused;
  `);
  await check("Pause releases a live command and rejects its pending replacement", `
    qev.pause(); const before = qev.engine.snapshot();
    if(qev.agent.busy) await resolveMock();
    await new Promise((r) => setTimeout(r, 250));
    const after = qev.engine.snapshot();
    return after.paused && after.tick === before.tick && after.actionTicksLeft === 0 && after.actionSerial === before.actionSerial && !qev.agent.active;
  `);
  await check("the feed contains exactly the five newest decisions, with only binary verdict labels", `
    while(qev.agent.history.length<7) {const pending=qev.score();await resolveMock();await pending;}
    const cards=[...document.querySelectorAll('.decision-card')];
    const expected=qev.agent.history.slice(-5).reverse().map(r=>String(r.id));
    return cards.length===5 && qev.agent.history.length>5 &&
      JSON.stringify(cards.map(c=>c.dataset.decisionId))===JSON.stringify(expected) &&
      cards.every((c,i)=>!i || c.getBoundingClientRect().top>cards[i-1].getBoundingClientRect().top) &&
      cards.every(c=>['Accepted','Rejected'].includes(c.querySelector('.decision-status').textContent)) &&
      document.querySelector('[data-decision-id="'+firstLive.id+'"] .decision-status').textContent==='Accepted';
  `);
  await check("new cards prepend without losing older expanded details, scroll position, or focus", `
    window.keptCard=document.querySelector('.decision-card');
    keptCard.querySelector('.decision-details').open=true;
    keptCard.querySelector('[data-section="request"]').open=true;
    keptCard.querySelector('[data-section="state"]').open=true;
    const statePre=keptCard.querySelector('[data-payload="state"]');statePre.scrollTop=40;
    const stateScroll=statePre.scrollTop, stateText=statePre.textContent;
    const pre=keptCard.querySelector('[data-payload="request"]');pre.scrollTop=40;
    const previousScroll=pre.scrollTop, originalText=pre.textContent;
    const button=keptCard.querySelector('[data-copy="request"]');button.focus({preventScroll:true});
    const pending=qev.score();await resolveMock();await pending;
    return document.querySelectorAll('.decision-card').length===5 &&
      document.querySelectorAll('.decision-card')[1]===keptCard && keptCard.querySelector('.decision-details').open &&
      keptCard.querySelector('[data-section="request"]').open && pre.scrollTop===previousScroll &&
      keptCard.querySelector('[data-section="state"]').open && statePre.scrollTop===stateScroll && statePre.textContent===stateText &&
      !document.querySelector('.decision-card [data-section="state"]').open &&
      pre.textContent===originalText && document.activeElement===button &&
      qev.agent.current.id===Number(document.querySelector('.decision-card').dataset.decisionId);
  `);
  await check("copy uses the selected card's untouched payload rather than the newest decision", `
    const original=navigator.clipboard.writeText;
    let copied;
    navigator.clipboard.writeText=async value=>{copied=value;};
    try {
      keptCard.querySelector('[data-copy="request"]').click();await new Promise(r=>setTimeout(r,0));
      const r=qev.agent.history.find(r=>String(r.id)===keptCard.dataset.decisionId);
      return copied===JSON.stringify(r.requests,null,2) && r.id!==qev.agent.current.id && !document.querySelector('#step').disabled;
    } finally {navigator.clipboard.writeText=original;keptCard.querySelector('.decision-details').open=false;}
  `);
  await check("rejected replies keep their exact response and show no extra lifecycle badge", `
    const pending=qev.score(), call=mockCalls.at(-1);
    const response=[{answers:{action:{type:'choice',choice:'not-offered',probabilities:{'not-offered':1}}},extra:'<img src=x onerror="window.injected=true">'}];
    call.resolve(response);
    try {await pending;return false;} catch { /* Expected protocol validation error. */ }
    const card=document.querySelector('.decision-card');
    return card.querySelector('.decision-status').textContent==='Rejected' &&
      JSON.stringify(JSON.parse(card.querySelector('[data-payload="response"]').textContent))===JSON.stringify(response) &&
      !window.injected && !card.querySelector('img') && qev.engine.snapshot().paused;
  `);
  await check("native live leases expire to neutral inputs without freezing world time", `
    const session = qev.engine.startAuto(), s = qev.engine.snapshot();
    const p = {epoch:s.epoch,tick:s.tick,dx:0,dy:0,slot:-1,generation:0,yaw:s.player.yaw+10,pitch:0,fire:false,ticks:6};
    if(!qev.engine.applyLive(p,session)) return false;
    await new Promise((r) => setTimeout(r, 400));
    const a = qev.engine.snapshot(); qev.pause();
    return !a.paused && a.tick-s.tick > 6 && a.actionTicksLeft === 0 && a.actionTicks === 6 && /lease expired/.test(a.stopReason);
  `);
  await check("native live guards reject stale sessions, old/future observations, and invalid leases", `
    const oldSession = qev.engine.startAuto();
    await new Promise((r) => setTimeout(r, 1100)); qev.pause();
    const session = qev.engine.startAuto(), s = qev.engine.snapshot();
    const p = {epoch:s.epoch,tick:s.tick,dx:0,dy:0,slot:-1,generation:0,yaw:s.player.yaw,pitch:0,fire:false,ticks:45};
    const rejected = !qev.engine.applyLive(p,oldSession) && !qev.engine.applyLive({...p,tick:s.tick-61},session) &&
      !qev.engine.applyLive({...p,tick:s.tick+1},session) && !qev.engine.applyLive({...p,epoch:s.epoch-1},session) &&
      !qev.engine.applyLive({...p,ticks:46},session) && !qev.engine.applyLive({...p,slot:9999,fire:true},session) &&
      qev.engine.module._qev_live_action(s.epoch,s.tick,session,NaN,0,-1,0,0,0,0,45) === 0;
    qev.pause(); return rejected;
  `);
  await check("a wall-time watchdog also releases commands when slowed simulation cannot expire the tick lease", `
    qev.engine.speed(0.1);
    const session = qev.engine.startAuto(), s = qev.engine.snapshot();
    qev.engine.applyLive({epoch:s.epoch,tick:s.tick,dx:0,dy:0,slot:-1,generation:0,yaw:s.player.yaw+90,pitch:0,fire:false,ticks:45},session);
    await new Promise((r) => setTimeout(r, 1700));
    const after = qev.engine.snapshot(); qev.pause(); qev.engine.speed(1);
    return !after.paused && after.actionTicksLeft === 0 && after.actionTicks > 0 && after.actionTicks < 45 && /watchdog/.test(after.stopReason);
  `);
  await check("repeated forward choices do not reverse an unfinished turn in the real engine", `
    qev.agent.invalidate(); await qev.engine.loadMap('qev_encounter');
    for(let i=0;i<90 && !qev.engine.snapshot().player.grounded;i++) await qev.engine.frame();
    const {Agent} = await import('/src/agent.js');
    const calls=[], model={info:{backend:'steering-test'},decideMany(requests){return new Promise(resolve=>calls.push({requests,resolve}));}};
    const agent=new Agent({engine:qev.engine,getModel:()=>model});
    const delta=(a,b)=>((a-b+540)%360+360)%360-180;
    // Face the open side of the arena to isolate steering from the new threat-aware
    // shortlist. A retreat/cover offer may legitimately displace forward in combat.
    for(let i=0;i<6 && Math.abs(delta(0,qev.engine.snapshot().player.yaw))>1;i++) {
      const s=qev.engine.snapshot();
      await qev.engine.act({epoch:s.epoch,tick:s.tick,dx:0,dy:0,slot:-1,generation:0,yaw:0,pitch:0,fire:false,ticks:12});
    }
    if(qev.engine.snapshot().enemies.length) throw new Error('Steering fixture still faces a threat');
    qev.engine.speed(0.25);
    try {
      agent.startLive();
      let pending=agent.score({realtime:true});
      const turn=agent.current.eligible.findIndex(c=>c.category==='exploration' && Math.abs(delta(c.params.yaw,agent.current.before.player.yaw))>=30);
      if(turn<0) throw new Error('No turning walk is available in the regression arena');
      const course=agent.current.eligible[turn].params.yaw;
      calls.at(-1).resolve(mockResponses(calls.at(-1),turn)); await pending;
      if(!agent.applyLive()) throw new Error('Initial turning walk was rejected');
      let error=Math.abs(delta(course,qev.engine.snapshot().player.yaw)), replacements=0;
      const evidence=[];
      for(let i=0;i<3;i++) {
        pending=agent.score({realtime:true});
        const r=agent.current, forward=r.eligible.findIndex(c=>c.id==='forward');
        const valid=forward>=0 && r.steering.source==='held-course' && Math.abs(delta(course,r.eligible[forward].params.yaw))<0.01;
        await new Promise(resolve=>setTimeout(resolve,160));
        calls.at(-1).resolve(mockResponses(calls.at(-1),Math.max(0,forward))); await pending;
        if(!valid) throw new Error('Steering reference regression: '+JSON.stringify({i,course,steering:r.steering,choices:r.eligible.map(c=>({id:c.id,yaw:c.params.yaw,ticks:c.params.ticks})),before:r.before,now:qev.engine.snapshot()}));
        const accepted=agent.applyLive(); if(accepted) replacements++;
        evidence.push({i,accepted,steering:r.steering,params:r.eligible[forward].params,now:qev.engine.snapshot()});
        // Current geometry may reject an old probe; rejection must leave the held course alone.
        const next=Math.abs(delta(course,qev.engine.snapshot().player.yaw));
        if(next>error+0.1) throw new Error('Turn reversed: '+JSON.stringify({i,error,next,course,now:qev.engine.snapshot()}));
        error=next;
      }
      await new Promise(resolve=>setTimeout(resolve,1000));
      if(!replacements || Math.abs(delta(course,qev.engine.snapshot().player.yaw))>=1) throw new Error('Turn did not finish with a forward replacement: '+JSON.stringify({course,replacements,evidence,now:qev.engine.snapshot()}));
      return true;
    } finally {agent.pause();qev.engine.speed(1);}
  `);
  await evaluate("(async()=>{qev.agent.invalidate(); await qev.engine.loadMap('qev_encounter',2);document.querySelector('#map').value='lq_e0m6';document.querySelector('#difficulty').value='3';})()");
  await evaluate("qev.engine.play()");
  await until(()=>evaluate("!qev.engine.snapshot().paused"));
  await bindKillForTest();
  await killPlayerViaConsole();
  await until(()=>evaluate('!!qev.respawner.pending'));
  const firstRespawn=await evaluate('qev.respawner.count');
  await until(()=>evaluate(`qev.respawner.count>${firstRespawn} && !qev.respawner.pending && qev.engine.snapshot().alive`));
  await check("death outside Auto restarts the active level and difficulty, staying paused", `
    return qev.engine.snapshot().map==='qev_encounter' && qev.engine.snapshot().difficulty===2 &&
      document.querySelector('#map').value==='lq_e0m6' && document.querySelector('#difficulty').value==='3' &&
      qev.engine.snapshot().paused && qev.playMode==='inspection';
  `);
  await evaluate('qev.pause()');
  await until(()=>evaluate("!document.querySelector('#auto').disabled"));
  await evaluate("document.querySelector('#auto').click()");
  await until(()=>evaluate('qev.agent.busy'));
  await evaluate('window.deadDecision=qev.agent.current;window.deadSession=qev.agent.liveSession');
  await killPlayerViaConsole();
  await until(()=>evaluate('!!qev.respawner.pending'));
  await until(()=>evaluate("qev.engine.snapshot().alive && qev.engine.snapshot().paused && qev.respawner.pending && document.querySelector('#status').textContent.includes('previous inference')"));
  await check("a new life waits for old inference and retains the active map/difficulty", `
    return qev.engine.snapshot().map==='qev_encounter' && qev.engine.snapshot().difficulty===2 &&
      qev.engine.snapshot().epoch!==deadDecision.before.epoch && !qev.agent.current;
  `);
  await evaluate('resolveMock()');
  await until(()=>evaluate("!qev.respawner.pending && qev.playMode==='auto' && qev.agent.busy && !qev.engine.snapshot().paused"));
  await check("Auto restarts in a fresh session; the dead player's late answer is discarded", `
    return deadDecision.status==='discarded' && !deadDecision.appliedAt && qev.agent.liveSession!==deadSession &&
      qev.agent.current.before.epoch===qev.engine.snapshot().epoch;
  `);
  await killPlayerViaConsole();
  await until(()=>evaluate('!!qev.respawner.pending'));
  await evaluate('qev.pause(); resolveMock()');
  await until(()=>evaluate('!qev.respawner.pending && qev.engine.snapshot().alive && !qev.agent.busy'));
  await check("Pause during respawn prevents a late automatic restart", `
    const tick=qev.engine.snapshot().tick;await new Promise(r=>setTimeout(r,300));
    return qev.engine.snapshot().paused && qev.engine.snapshot().tick===tick && qev.playMode==='inspection' && document.querySelector('#auto').getAttribute('aria-pressed')==='false';
  `);
  await evaluate("(async()=>{qev.agent.invalidate();await qev.engine.loadMap('qev_encounter',0);document.querySelector('#map').value='qev_encounter';document.querySelector('#difficulty').value='0';})()");
  if (runModel) {
    await evaluate("qev.agent.getModel = originalModel; qev.agent.invalidate()");
    await until(()=>evaluate("!document.querySelector('#model').disabled"));
    await evaluate("document.querySelector('#model').value='laya';document.querySelector('#model').dispatchEvent(new Event('change',{bubbles:true}))");
    await check("choosing Laya directly loads the real model and blocks Start while loading", `
      return document.querySelector('#model').value==='laya' && document.querySelector('#model').disabled &&
        document.querySelector('#auto').disabled && !document.querySelector('#cancel-model').hidden &&
        !document.querySelector('#load-model, #model-required') && qev.engine.snapshot().paused && qev.playMode==='inspection';
    `);
    await evaluate(`(async () => { for (let i = 0; i < 90 && !qev.engine.snapshot().player.grounded; i++) await qev.engine.frame(); })()`);
    await until(() => evaluate("!!qev.model"), 300_000);
    await check("loading real Laya from the dropdown does not automatically resume play", `
      return qev.engine.snapshot().paused && qev.playMode==='inspection' && !document.querySelector('#auto').disabled &&
        document.querySelector('#auto').getAttribute('aria-pressed')==='false';
    `);
    console.log("Live model:", await evaluate("({backend:qev.model.info.backend,arch:qev.model.info.arch})"));
    await evaluate("document.querySelector('[data-priority=get-supplies] [data-move=up]').click();document.querySelector('#step').click()");
    await until(() => evaluate("qev.agent.current?.status === 'executed' && qev.engine.snapshot().paused"), 180_000);
    await check("one UI Step sends the reordered priorities to real Kevala, executes twelve ticks, and stops", `
      const r=qev.agent.current, {goalPrompt}=await import('/src/objective.js');
      return r.priorityOrder[0]==='get-supplies' && r.requests[0].state.startsWith(goalPrompt(qev.priorityOrder)) &&
        r.responses.length===r.requests.length && r.ranking.every(s=>Number.isFinite(s.probability) && s.probability>=0 && s.probability<=1) &&
        r.after.tick-r.before.tick===12 && qev.engine.snapshot().paused && qev.playMode==='inspection';
    `);
    console.log("Live decision:", await evaluate("({ms:qev.agent.current.ms,inputs:qev.agent.current.requests.length,actions:qev.agent.current.eligible.length,chosen:qev.agent.current.eligible[qev.agent.current.selectedIndex].label,response:qev.agent.current.responses[0]})"));
    await writeFile(resolve(root, "build/live-trace.json"), await evaluate("JSON.stringify(qev.agent.current,null,2)"));
    const id = await evaluate("qev.agent.current.id");
    await evaluate("document.querySelector('#reset-priorities').click()");
    await until(() => evaluate("!document.querySelector('#auto').disabled"));
    await evaluate(`window.liveSamples=[]; window.sampleTimer=setInterval(()=>{
      if(qev.agent.liveSession !== null && qev.agent.inflight) {
        const s=qev.engine.snapshot();
        if(s.controlSession===qev.agent.liveSession) liveSamples.push({id:qev.agent.current.id,tick:s.tick,paused:s.paused});
      }
    },50); document.querySelector('#auto').click()`);
    await until(() => evaluate(`qev.agent.history.filter(r => r.id > ${id} && r.appliedAt && r.after).length >= 2`), 120_000);
    await evaluate("qev.pause()");
    await until(() => evaluate("!qev.agent.busy"), 120_000);
    await evaluate("clearInterval(sampleTimer)");
    await check("real Laya scores in its worker while the game advances, applies fresh decisions, and stops on demand", `
      const tick = qev.engine.snapshot().tick;
      await new Promise((r) => setTimeout(r, 300));
      const applied = qev.agent.history.filter(r => r.id > ${id} && r.appliedAt);
      return qev.engine.snapshot().paused && qev.engine.snapshot().tick === tick && applied.length >= 2 &&
        applied.every(r => r.mode === 'realtime' && r.ageTicksAtApply > 0 && r.ageTicksAtApply <= 60 && r.ageMsAtApply <= 1500) &&
        liveSamples.every(s => !s.paused) && liveSamples.some((s,i)=>i && s.id===liveSamples[i-1].id && s.tick>liveSamples[i-1].tick);
    `);
    console.log('Real-time evidence:', await evaluate(`({samples:liveSamples.length,decisions:qev.agent.history.filter(r=>r.id>${id}&&r.appliedAt).map(r=>({id:r.id,ms:r.ms,observedTick:r.before.tick,appliedTick:r.appliedAt.tick,ticksApplied:r.execution?.ticksApplied,status:r.status}))})`));
    await writeFile(resolve(root, "build/live-history.json"), await evaluate("JSON.stringify(qev.agent.history.filter(r=>r.model.arch==='laya'),null,2)"));
  }
  if (explore) {
    const reports = [];
    for (const map of ['lq_e0m1','lq_e0m2']) {
      await evaluate(`document.querySelector('#map').value=${JSON.stringify(map)}; document.querySelector('#map').dispatchEvent(new Event('change',{bubbles:true}))`);
      await until(() => evaluate(`qev.engine.snapshot().ready && qev.engine.snapshot().paused && qev.engine.snapshot().map===${JSON.stringify(map)} && !qev.agent.busy && !document.querySelector('#auto').disabled`));
      const firstId = await evaluate('qev.agent.sequence');
      const initialObservation = await evaluate('qev.engine.snapshot()');
      await evaluate(`window.trialRecords=new Map(); window.savedOnChange=qev.agent.onChange;
        qev.agent.onChange=()=>{const r=qev.agent.current;if(r && r.id>${firstId}) trialRecords.set(r.id,r);savedOnChange();};
        document.querySelector('#auto').click()`);
      const started = Date.now();
      while (Date.now() - started < 30_000) {
        await sleep(500);
        if (await evaluate("!qev.engine.snapshot().alive || qev.engine.snapshot().completed || document.querySelector('#auto').getAttribute('aria-pressed')==='false'")) break;
      }
      await evaluate('qev.pause()');
      await until(() => evaluate('!qev.agent.busy'), 15_000);
      const report = await evaluate(`({map:${JSON.stringify(map)},observation:qev.engine.snapshot(),exploration:qev.agent.navigation.inspect(),records:[...trialRecords.values()]})`);
      await evaluate('qev.agent.onChange=savedOnChange; delete window.trialRecords; delete window.savedOnChange');
      report.start = initialObservation;
      reports.push(report);
      console.log('Full-level exploration:', {map,alive:report.observation.alive,completed:report.observation.completed,cells:report.exploration.rememberedCells,moved:report.exploration.distanceMoved,scans:report.exploration.stationaryScans,decisions:report.records.length,applied:report.records.filter(r=>r.appliedAt).length,choices:report.records.filter(r=>r.appliedAt).map(r=>r.eligible[r.selectedIndex].id)});
      await writeFile(resolve(root, `build/exploration-${map}.json`), JSON.stringify(report, null, 2));
      assert.ok(report.records.some(r=>r.appliedAt), 'the full-level run must actually apply a model choice');
      // Survival may correctly hold cover instead of maximizing distance or newly visited cells.
      assert.ok(report.records.every(r=>r.objective==='SURVIVE' && r.requests.every(x=>x.state.startsWith('Goal: SURVIVE'))), 'every full-level request makes survival primary');
      assert.equal(report.exploration.goalComplete, report.observation.completed, 'the navigation completion flag still means engine-confirmed level completion, not a survival score');
    }
    await writeFile(resolve(root, 'build/exploration-summary.json'), JSON.stringify(reports.map(r=>({map:r.map,alive:r.observation.alive,completed:r.observation.completed,cells:r.exploration.rememberedCells,moved:r.exploration.distanceMoved,applied:r.records.filter(x=>x.appliedAt).length})),null,2));
  }
  if (compare) await compareDecisions({ evaluate, root });
  if (assistanceTrials) {
    const report = await runAssistanceTrials({ evaluate, check, until, onStopped: async mode => {
      await evaluate("window.scrollTo({top:0,behavior:'instant'})");
      const image = await call('Page.captureScreenshot', {format:'png'});
      await writeFile(resolve(root, `build/qev-${mode}-trial.png`), Buffer.from(image.data,'base64'));
    } });
    await writeFile(resolve(root, 'build/assistance-trials.json'), JSON.stringify(report,null,2));
    console.log('Illustrative assistance trials:', report.runs.map(({records,start,end,choices,...summary})=>summary));
    console.log('Trial caveat:', report.caveat);
  }
  await evaluate("window.scrollTo({top:document.querySelector('.workbench').offsetTop-10,behavior:'instant'})");
  await sleep(100);
  const shot = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(resolve(root, "build/qev-desktop.png"), Buffer.from(shot.data, "base64"));
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(150);
  await check("mobile layout fits without horizontal overflow", `return document.documentElement.scrollWidth <= innerWidth;`);
  const mobile = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(resolve(root, "build/qev-mobile.png"), Buffer.from(mobile.data, "base64"));
  assert.deepEqual(errors, [], "no uncaught browser exceptions");
  console.log(`Browser smoke passed: real Qwasm, demo-only LibreQuake + loading/failure regressions, ${runModel ? "live Laya + mocked race tests" : "mocked inference for control tests"}.`);
} catch (error) {
  if (evaluate) console.error("Browser diagnostics:", await evaluate("({error:document.querySelector('#error')?.textContent,model:document.querySelector('#model-status')?.textContent,status:document.querySelector('#status')?.textContent,log:window.qev?.engineLog})").catch(() => null));
  console.error("Browser exceptions:", errors);
  throw error;
} finally {
  ws?.close(); chrome.kill("SIGTERM");
  server.closeAllConnections(); await new Promise((r) => server.close(r));
  await sleep(1000);
}
