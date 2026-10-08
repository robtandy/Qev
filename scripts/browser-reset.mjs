// Real engine + deliberately delayed inference/load replies. Host output is muted by the parent harness.
export async function checkReset({ evaluate, check, until, call, bindKillForTest, killPlayerViaConsole }) {
  const idle = () => until(() => evaluate("qev.engine.snapshot().ready && qev.engine.snapshot().paused && !document.querySelector('#reset').disabled"));
  const fresh = async (difficulty = 2) => {
    await evaluate(`document.querySelector('#map').value='qev_encounter';document.querySelector('#difficulty').value='${difficulty}';document.querySelector('#map').dispatchEvent(new Event('change',{bubbles:true}))`);
    await idle();
  };
  const reset = async () => {
    await evaluate("resetTest.beforeReset=qev.engine.snapshot();document.querySelector('#reset').click()");
    await until(() => evaluate("qev.engine.snapshot().epoch!==resetTest.beforeReset.epoch && qev.engine.snapshot().ready && !document.querySelector('#reset').disabled"));
  };
  const click = async id => {
    const p = await evaluate(`(()=>{const b=document.getElementById(${JSON.stringify(id)});b.scrollIntoView({block:'nearest'});const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...p });
  };
  await evaluate(`window.resetTest={getModel:qev.agent.getModel,loadMap:qev.engine.loadMap,resumeAudio:qev.engine.resumeAudio,
    respawns:qev.respawner.enabled,loads:[],calls:[],resumes:0};qev.respawner.enabled=false;
    qev.engine.resumeAudio=function(...args){resetTest.resumes++;return resetTest.resumeAudio.apply(this,args);};
    qev.engine.loadMap=function(...args){
      resetTest.loads.push(args);const load=()=>resetTest.loadMap.apply(this,args);
      if(!resetTest.deferLoad)return load();
      return new Promise((resolve,reject)=>{resetTest.releaseLoad=()=>{resetTest.deferLoad=false;resetTest.releaseLoad=null;load().then(resolve,reject);};});
    };
    resetTest.answer=(index,id='wait')=>{const c=resetTest.calls[index];if(!c || c.done)return;c.done=true;
      const keys=Object.keys(c.requests[0].questions.action.criteria), choice=keys.includes(id)?id:keys[0];
      c.resolve([{answers:{action:{type:'choice',choice,probabilities:Object.fromEntries(keys.map(k=>[k,k===choice?1:0]))}}}]);};`);
  try {
    await reset();
    await check('Reset works without selecting or downloading a model and does not unlock audio', `
      const before=resetTest.beforeReset, after=qev.engine.snapshot();
      return !qev.model && !qev.agent.getModel() && after.map===before.map && after.difficulty===before.difficulty &&
        after.alive && after.paused && !after.remaining && after.actionTicksLeft===0 && qev.playMode==='inspection' &&
        resetTest.resumes===0 && document.querySelector('#model').value==='';
    `);
    await fresh();
    await evaluate(`document.querySelector('#assistance').value='unassisted';document.querySelector('#assistance').dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('[data-priority=get-supplies] [data-move=up]').click();
      resetTest.order=JSON.stringify(qev.priorityOrder);
      resetTest.model={info:{backend:'reset-regression'},decideMany(requests){return new Promise(resolve=>resetTest.calls.push({requests,resolve}));}};
      qev.agent.getModel=()=>resetTest.model;qev.agent.invalidate()`);
    await until(() => evaluate("!document.querySelector('#step').disabled"));
    await evaluate("document.querySelector('#step').click();resetTest.executed=qev.agent.current;resetTest.answer(resetTest.calls.length-1,'fire')");
    await until(() => evaluate("!qev.agent.busy && resetTest.executed.status==='executed'"));
    await evaluate("resetTest.historyState=JSON.stringify(resetTest.executed.requests);resetTest.resumeCount=resetTest.resumes");
    await reset();
    await check('Reset restores the current level/loadout while preserving model, assistance, priorities and historical requests', `
      const s=qev.engine.snapshot();
      return s.map==='qev_encounter' && s.difficulty===2 && s.assistance==='unassisted' && s.paused && s.alive &&
        s.player.health===100 && s.player.ammo===25 && resetTest.beforeReset.player.ammo<25 &&
        qev.agent.getModel()===resetTest.model && JSON.stringify(qev.priorityOrder)===resetTest.order &&
        qev.agent.history.includes(resetTest.executed) && JSON.stringify(resetTest.executed.requests)===resetTest.historyState &&
        !qev.agent.current && qev.agent.memory===null && qev.agent.navigation.inspect().rememberedCells===0 &&
        resetTest.resumes===resetTest.resumeCount && document.querySelector('#assistance').value==='unassisted';
    `);

    await evaluate(`document.querySelector('#step').click();resetTest.pendingStep=qev.agent.current;resetTest.stepCall=resetTest.calls.length-1;
      resetTest.pendingState=JSON.stringify(resetTest.pendingStep.requests);resetTest.loadCount=resetTest.loads.length;resetTest.deferLoad=true;
      document.querySelector('#map').value='lq_e0m1';document.querySelector('#difficulty').value='0';document.querySelector('#reset').click();
      document.querySelector('#reset').click();document.querySelector('#reset').dispatchEvent(new Event('click',{bubbles:true}))`);
    await check('Reset is single-flight, disables during loading and uses actual map/skill rather than stale selectors', `
      return document.querySelector('#reset').disabled && document.querySelector('#status').textContent.includes('Resetting') &&
        resetTest.loads.length===resetTest.loadCount+1 && resetTest.loads.at(-1).join(',')==='qev_encounter,2' &&
        qev.engine.snapshot().paused && resetTest.pendingStep.status==='cancelled';
    `);
    await evaluate("resetTest.releaseLoad()"); await idle();
    await check('the fresh level cannot start while the obsolete Step inference is still settling', `
      resetTest.frozen=qev.engine.snapshot();
      return qev.agent.busy && document.querySelector('#auto').disabled && document.querySelector('#step').disabled &&
        document.querySelector('#map').value==='qev_encounter' && document.querySelector('#difficulty').value==='2';
    `);
    await evaluate("resetTest.answer(resetTest.stepCall,'fire')");
    await until(() => evaluate("!qev.agent.busy"));
    await check('a late pre-reset Step answer is discarded without firing in or resuming the new life', `
      await new Promise(r=>setTimeout(r,180));const s=qev.engine.snapshot();
      return resetTest.pendingStep.status==='discarded' && !resetTest.pendingStep.after && !resetTest.pendingStep.appliedAt &&
        JSON.stringify(resetTest.pendingStep.requests)===resetTest.pendingState && s.epoch===resetTest.frozen.epoch &&
        s.tick===resetTest.frozen.tick && s.paused && s.player.ammo===25;
    `);

    await evaluate(`document.querySelector('#speed').value='0.1';document.querySelector('#speed').dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('#step').click();resetTest.actingStep=qev.agent.current;resetTest.answer(resetTest.calls.length-1,'forward')`);
    await until(() => evaluate("qev.agent.executing && qev.engine.snapshot().remaining>0 && qev.engine.snapshot().tick>resetTest.actingStep.before.tick"));
    await reset(); await until(() => evaluate("!qev.agent.busy"));
    await check('Reset also interrupts an executing Step and retains the selected playback speed', `
      return resetTest.actingStep.status==='interrupted' && qev.engine.snapshot().paused && !qev.engine.snapshot().remaining &&
        !qev.engine.snapshot().actionTicksLeft && qev.playMode==='inspection' && document.querySelector('#speed').value==='0.1';
    `);
    await evaluate("document.querySelector('#speed').value='1';document.querySelector('#speed').dispatchEvent(new Event('change',{bubbles:true}));document.activeElement.blur();document.querySelector('#auto').click()");
    await until(() => evaluate("qev.agent.busy && !qev.engine.snapshot().paused"));
    await evaluate("resetTest.live=qev.agent.current;resetTest.liveCall=resetTest.calls.length-1;resetTest.hoverTick=qev.engine.snapshot().tick;resetTest.hoverFocus=document.activeElement");
    const hover = await evaluate("(()=>{const r=document.querySelector('#assistance-help-button').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...hover });
    await check('hovering help during Auto does not pause gameplay, steal focus or cancel the pending decision', `
      await new Promise(r=>setTimeout(r,220));const s=qev.engine.snapshot();
      return !document.querySelector('#assistance-help-preview').hidden && !s.paused && s.tick>resetTest.hoverTick &&
        qev.playMode==='auto' && resetTest.live.status==='scoring' && document.activeElement===resetTest.hoverFocus;
    `);
    await click('reset'); await idle();
    await evaluate("resetTest.liveFrozen=qev.engine.snapshot();resetTest.answer(resetTest.liveCall,'fire')");
    await until(() => evaluate("!qev.agent.busy"));
    await check('Reset during Auto rejects the old reply and never resumes automatically', `
      await new Promise(r=>setTimeout(r,180));const s=qev.engine.snapshot();
      return resetTest.live.status==='discarded' && !resetTest.live.appliedAt && s.epoch!==resetTest.live.before.epoch &&
        s.tick===resetTest.liveFrozen.tick && s.paused && s.actionTicksLeft===0 && qev.playMode==='inspection';
    `);

    await evaluate("document.querySelector('#step').click();resetTest.helpStep=qev.agent.current;resetTest.helpCall=resetTest.calls.length-1");
    await click('assistance-help-button');
    await check('deliberately opening the help modal stops play and cancels a pending Step', `
      resetTest.helpFrozen=qev.engine.snapshot();resetTest.helpCalls=resetTest.calls.length;
      return document.querySelector('#assistance-help').matches(':modal') && qev.playMode==='inspection' &&
        resetTest.helpFrozen.paused && resetTest.helpStep.status==='cancelled';
    `);
    for (const [key, code, vk] of [['n', 'KeyN', 78], ['p', 'KeyP', 80]]) {
      await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, text: key });
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    }
    await check('game shortcuts do not run behind the help modal', `
      return resetTest.calls.length===resetTest.helpCalls && qev.engine.snapshot().controlSession===resetTest.helpFrozen.controlSession;
    `);
    await evaluate("resetTest.answer(resetTest.helpCall,'fire');document.querySelector('#assistance-help .help-foot [data-help-close]').click()");
    await until(() => evaluate("!qev.agent.busy"));
    await check('closing help does not apply the cancelled reply or resume the simulation', `
      const s=qev.engine.snapshot();return resetTest.helpStep.status==='discarded' && !resetTest.helpStep.after &&
        !document.querySelector('#assistance-help').open && s.paused && s.tick===resetTest.helpFrozen.tick;
    `);

    await evaluate("qev.engine.play()"); await bindKillForTest(); await killPlayerViaConsole();
    await until(() => evaluate("!qev.engine.snapshot().alive && qev.engine.snapshot().paused && !document.querySelector('#reset').disabled"));
    await reset();
    await check('manual Reset can recover a dead episode without requiring a model change or automatic respawn', `
      const s=qev.engine.snapshot();return s.alive && s.paused && s.map==='qev_encounter' && s.difficulty===2 &&
        s.assistance==='unassisted' && qev.agent.getModel()===resetTest.model && JSON.stringify(qev.priorityOrder)===resetTest.order;
    `);
  } finally {
    await evaluate(`qev.pause();document.querySelector('#assistance-help .help-head [data-help-close]').click();
      if(resetTest.releaseLoad)resetTest.releaseLoad();for(let i=0;i<resetTest.calls.length;i++)resetTest.answer(i);
      qev.agent.getModel=resetTest.getModel;qev.engine.loadMap=resetTest.loadMap;qev.engine.resumeAudio=resetTest.resumeAudio;qev.agent.invalidate()`);
    await until(() => evaluate("!qev.agent.busy && !document.querySelector('#reset').disabled"));
    await evaluate(`document.querySelector('#speed').value='1';document.querySelector('#speed').dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('#assistance').value='assisted';document.querySelector('#assistance').dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('#reset-priorities').click();qev.agent.history.length=0;qev.agent.invalidate()`);
    await fresh(0);
    await evaluate("(async()=>{for(let i=0;i<90&&!qev.engine.snapshot().player.grounded;i++)await qev.engine.frame();qev.respawner.enabled=resetTest.respawns;delete window.resetTest;document.activeElement.blur();scrollTo(0,0)})()");
  }
}
