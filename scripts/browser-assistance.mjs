// Muted-browser regressions for the actual C bridge and the assisted/unassisted UI boundary.
// Precise telemetry below is test-only setup/auditing in assisted mode, never raw model input.
export async function checkAssistance({ evaluate, check, until, bindKillForTest, killPlayerViaConsole }) {
  const mode = value => evaluate(`document.querySelector('#assistance').value=${JSON.stringify(value)};document.querySelector('#assistance').dispatchEvent(new Event('change',{bubbles:true}))`);
  const fresh = async () => {
    await evaluate("qev.pause();document.querySelector('#map').value='qev_encounter';document.querySelector('#difficulty').value='0';document.querySelector('#map').dispatchEvent(new Event('change',{bubbles:true}))");
    await until(() => evaluate("qev.engine.snapshot().ready && qev.engine.snapshot().alive && !document.querySelector('#map').disabled"));
  };
  await evaluate(`window.assistanceTest={getModel:qev.agent.getModel,probe:qev.engine.probe,respawns:qev.respawner.enabled,calls:[],records:[]};qev.respawner.enabled=false;
    assistanceTest.raw=async(overrides={})=>{const s=qev.engine.snapshot();return qev.engine.act({input:'relative',epoch:s.epoch,tick:s.tick,forward:0,side:0,yawRate:0,pitchRate:0,fire:false,ticks:12,...overrides});}`);
  try {
    await fresh();
    await check("assistance starts on with an explicit off/visible-telemetry experiment, not a human-equivalence claim", `
      assistanceTest.before=qev.engine.snapshot();
      return assistanceTest.before.assistance==='assisted' && Array.isArray(assistanceTest.before.player.position) &&
        document.querySelector('#assistance').value==='assisted' && !document.querySelector('#assistance').disabled &&
        document.querySelector('#assistance').getAttribute('aria-describedby')==='assistance-note' &&
        document.querySelector('#assistance option[value=unassisted]').textContent==='Off · visible telemetry';
    `);
    await mode('unassisted');
    await check("switching off advances the input epoch without resetting the level and redacts precise native observations", `
      const s=qev.engine.snapshot(), before=assistanceTest.before;
      const hidden=['position','yaw','pitch','grounded','inWater','slot','generation','distance','bearingRight'];
      return s.version===2 && s.assistance==='unassisted' && s.epoch!==before.epoch && s.tick===before.tick &&
        s.map===before.map && s.difficulty===before.difficulty && s.player.health===before.player.health && s.player.ammo===before.player.ammo &&
        s.paused && !s.remaining && s.actionTicksLeft===0 && qev.playMode==='inspection' &&
        [s.player,...s.enemies,...s.pickups].every(value=>hidden.every(key=>!(key in value))) &&
        s.enemies.length>0 && [...s.enemies,...s.pickups].every(e=>e.visible && e.kind && e.bearing && e.elevation && e.range) &&
        document.querySelector('#assistance-note').textContent.includes('not pixels/audio');
    `);
    await check("native off mode rejects probes, assisted actions, invalid modes and malformed raw input", `
      const s=qev.engine.snapshot(), m=qev.engine.module;
      return /disabled/.test(qev.engine.probe({dx:0,dy:0,slot:-1,generation:0,ticks:12}).error) &&
        m._qev_action(s.epoch,s.tick,0,0,-1,0,0,0,0,12)===0 &&
        m._qev_assistance(-1)===0 && m._qev_assistance(2)===0 &&
        m._qev_input_action(s.epoch,s.tick-1,0,0,0,0,0,12)===0 &&
        m._qev_input_action(s.epoch,s.tick,NaN,0,0,0,0,12)===0 &&
        m._qev_input_action(s.epoch,s.tick,1,1,0,0,0,12)===0 &&
        m._qev_input_action(s.epoch,s.tick,0,0,181,0,0,12)===0 &&
        m._qev_input_action(s.epoch,s.tick,0,0,0,Infinity,0,12)===0 &&
        m._qev_input_action(s.epoch,s.tick,0,0,0,0,2,12)===0 &&
        m._qev_input_action(s.epoch,s.tick,0,0,0,0,0,13)===0 && qev.engine.snapshot().tick===s.tick;
    `);
    await evaluate("assistanceTest.oldRaw=qev.engine.snapshot()");
    await mode('assisted'); await mode('unassisted');
    await check("an off/on/off round trip cannot replay a paused raw action at the same game tick", `
      const old=assistanceTest.oldRaw, now=qev.engine.snapshot();
      return now.tick===old.tick && now.epoch!==old.epoch &&
        qev.engine.module._qev_input_action(old.epoch,old.tick,0,0,0,0,1,12)===0;
    `);
    await evaluate("assistanceTest.raw({yawRate:60,pitchRate:-45,fire:true})");
    await mode('assisted');
    await check("raw look/fire applies the requested rates instead of locking the view onto an enemy", `
      const s=qev.engine.snapshot(), before=assistanceTest.before, delta=(a,b)=>((a-b+540)%360)-180;
      return Math.abs(delta(s.player.yaw,before.player.yaw)-12)<0.2 && Math.abs(s.player.pitch-before.player.pitch+9)<0.2 &&
        s.player.ammo<before.player.ammo && s.tick-before.tick===12 && s.paused;
    `);
    await check("native assisted mode rejects the raw-input entry point", `
      const s=qev.engine.snapshot();return qev.engine.module._qev_input_action(s.epoch,s.tick,0,0,0,0,1,12)===0;
    `);
    await mode('unassisted'); await fresh();
    await check("assistance-off persists across new-game/map loading", `
      return qev.engine.snapshot().assistance==='unassisted' && document.querySelector('#assistance').value==='unassisted';
    `);
    await evaluate("(async()=>{await assistanceTest.raw({yawRate:180});await assistanceTest.raw({yawRate:180});assistanceTest.blind=qev.engine.snapshot()})()");
    await check("the test can face away from the encounter without revealing hidden contacts", `return assistanceTest.blind.enemies.length===0;`);
    await evaluate("assistanceTest.raw({fire:true})");
    await check("raw fire is accepted and spends actual ammunition even with no visible target", `
      const after=qev.engine.snapshot();return after.player.ammo<assistanceTest.blind.player.ammo && after.tick-assistanceTest.blind.tick===12 && after.paused;
    `);
    await mode('assisted'); await fresh();
    await check("the controlled encounter contains a route vetoed by assisted geometry checks", `
      const s=qev.engine.snapshot(), a=s.player.yaw*Math.PI/180;
      const options=[{forward:1,side:0},{forward:-1,side:0},{forward:0,side:-1},{forward:0,side:1}];
      assistanceTest.blocked=options.map(input=>{
        const dx=input.forward*Math.cos(a)+input.side*Math.sin(a),dy=input.forward*Math.sin(a)-input.side*Math.cos(a);
        return {...input,dx,dy,probe:qev.engine.probe({dx,dy,slot:-1,generation:0,ticks:45})};
      }).find(c=>c.probe.blocked || !c.probe.supported || c.probe.hazard);
      if(!assistanceTest.blocked) return false;
      const session=qev.engine.startAuto(), now=qev.engine.snapshot(), c=assistanceTest.blocked;
      const accepted=qev.engine.applyLive({epoch:now.epoch,tick:now.tick,dx:c.dx,dy:c.dy,slot:-1,generation:0,yaw:s.player.yaw,pitch:s.player.pitch,fire:false,ticks:45},session);
      qev.pause();return accepted===false;
    `);
    await mode('unassisted');
    await evaluate(`(() => {
      const session=qev.engine.startAuto(), s=qev.engine.snapshot(), c=assistanceTest.blocked;
      assistanceTest.rawStarted=s.tick;
      if(!qev.engine.applyLive({input:'relative',epoch:s.epoch,tick:s.tick,forward:c.forward,side:c.side,yawRate:0,pitchRate:0,fire:false,ticks:45},session))throw new Error('Raw movement was vetoed');
    })()`);
    await until(() => evaluate("qev.engine.snapshot().actionTicks>=8"));
    await check("the same raw movement runs without the assisted route veto or per-tick geometry guard", `
      const s=qev.engine.snapshot();qev.pause();return s.actionTicks>=8 && s.stopReason!=='Movement guard stopped a changed or unsupported route.';
    `);
    await fresh();
    await evaluate(`qev.engine.probe=()=>{throw new Error('A raw controller tried to probe geometry');};
      assistanceTest.model={info:{backend:'assistance-regression'},decideMany(requests){return new Promise(resolve=>assistanceTest.calls.push({requests,resolve}));}};
      qev.agent.getModel=()=>assistanceTest.model;
      assistanceTest.answer=(index,id='fire')=>{
        const job=assistanceTest.calls[index], keys=Object.keys(job.requests[0].questions.action.criteria), chosen=keys.includes(id)?id:keys[0];
        job.resolve([{answers:{action:{type:'choice',choice:chosen,probabilities:Object.fromEntries(keys.map(key=>[key,key===chosen?1:0]))}}}]);
      };qev.agent.invalidate()`);
    await until(() => evaluate("!document.querySelector('#step').disabled"));
    await evaluate("document.querySelector('#step').click();assistanceTest.records.push(qev.agent.current);assistanceTest.original=JSON.stringify(qev.agent.current.requests)");
    await check("off-mode UI sends all 14 fixed inputs with coarse observations and no GPS/geometry facts", `
      const r=assistanceTest.records[0];
      return r.assistance==='unassisted' && r.eligible.length===14 && r.eligible.every(c=>c.params.input==='relative' && c.allowed && !c.geometry && !c.route) &&
        r.navigation===null && r.steering===null && !('position' in r.before.player) &&
        r.requests===assistanceTest.calls[0].requests && r.requests[0].state.includes('Assistance OFF') &&
        !/LOS blocked|LOS clear|clear floor|new cell|waypoint|enemy farther/.test(r.requests[0].state) &&
        document.querySelector('.decision-meta').textContent.includes('aids off');
    `);
    await mode('assisted');
    await evaluate("assistanceTest.answer(0)");
    await until(() => evaluate("!qev.agent.busy"));
    await check("switching assistance cancels a pending Step and preserves its original mode/prompt", `
      const r=assistanceTest.records[0];return r.status==='discarded' && r.assistance==='unassisted' &&
        JSON.stringify(r.requests)===assistanceTest.original && !r.appliedAt && qev.engine.snapshot().paused;
    `);
    await mode('unassisted');
    await until(() => evaluate("!document.querySelector('#step').disabled"));
    await evaluate("document.querySelector('#step').click();assistanceTest.records.push(qev.agent.current);assistanceTest.answer(1,'left-fire')");
    await until(() => evaluate("!qev.agent.busy && qev.agent.current?.status==='executed'"));
    await check("raw Step executes its exact input and remembers only the input and HUD changes", `
      const r=assistanceTest.records[1];return r.after.tick-r.before.tick===12 && r.eligible[r.selectedIndex].id==='left-fire' &&
        r.navigationAfter===null && !('displacement' in qev.agent.memory) && !('position' in r.after.player) &&
        qev.agent.navigation.inspect().rememberedCells===0 && qev.engine.snapshot().paused;
    `);
    await evaluate("document.querySelector('#auto').click()");
    await until(() => evaluate("qev.agent.busy && assistanceTest.calls.length===3"));
    await evaluate("assistanceTest.records.push(qev.agent.current);assistanceTest.answer(2,'fire')");
    await until(() => evaluate("assistanceTest.records[2].appliedAt && assistanceTest.calls.length>=4"));
    await check("raw real-time application also avoids post-application geometry and GPS navigation", `
      const r=assistanceTest.records[2];return r.appliedAt && r.appliedGeometry===null && r.appliedNavigation===null;
    `);
    await evaluate("qev.engine.probe=assistanceTest.probe;assistanceTest.pending=qev.agent.current");
    await mode('assisted');
    await evaluate("assistanceTest.stopped=qev.engine.snapshot();for(let i=3;i<assistanceTest.calls.length;i++)assistanceTest.answer(i)");
    await until(() => evaluate("!qev.agent.busy"));
    await check("switching during raw Auto releases inputs and rejects the old reply without restarting", `
      await new Promise(r=>setTimeout(r,200));
      return assistanceTest.pending.status==='discarded' && !assistanceTest.pending.appliedAt && qev.engine.snapshot().paused &&
        qev.engine.snapshot().tick===assistanceTest.stopped.tick && qev.engine.snapshot().actionTicksLeft===0 && qev.playMode==='inspection';
    `);
    await evaluate("void qev.score();assistanceTest.assisted=qev.agent.current;assistanceTest.assistedCall=assistanceTest.calls.length-1");
    await mode('unassisted');
    await evaluate("assistanceTest.answer(assistanceTest.assistedCall)");
    await until(() => evaluate("!qev.agent.busy"));
    await check("the reverse assisted-to-off switch also discards in-flight decisions and clears GPS memory", `
      return assistanceTest.assisted.assistance==='assisted' && assistanceTest.assisted.status==='discarded' &&
        qev.agent.memory===null && qev.agent.navigation.inspect().rememberedCells===0 && qev.engine.snapshot().paused;
    `);
    await until(() => evaluate("!document.querySelector('#step').disabled"));
    await evaluate("document.querySelector('#speed').value='0.1';document.querySelector('#speed').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#step').click();assistanceTest.slowStep=qev.agent.current;assistanceTest.answer(assistanceTest.calls.length-1,'forward')");
    await until(() => evaluate("qev.agent.executing && qev.engine.snapshot().remaining>0"));
    await mode('assisted');
    await until(() => evaluate("!qev.agent.busy"));
    await check("a mode switch also interrupts raw Step execution instead of carrying its inputs across the boundary", `
      const r=assistanceTest.slowStep;
      return r.assistance==='unassisted' && r.status==='interrupted' && r.after.tick-r.before.tick<12 &&
        qev.engine.snapshot().paused && qev.engine.snapshot().remaining===0 && qev.playMode==='inspection';
    `);
    await evaluate("document.querySelector('#speed').value='1';document.querySelector('#speed').dispatchEvent(new Event('change',{bubbles:true}))");
    await mode('unassisted');
    await evaluate(`(() => {
      const create=URL.createObjectURL,click=HTMLAnchorElement.prototype.click;
      URL.createObjectURL=function(blob){assistanceTest.exported=blob.text().then(JSON.parse);return create.call(this,blob);};
      HTMLAnchorElement.prototype.click=function(){};
      try{document.querySelector('#export').click();}finally{URL.createObjectURL=create;HTMLAnchorElement.prototype.click=click;}
    })()`);
    await check("version-6 traces label each experiment mode and omit current GPS memory when off", `
      const trace=await assistanceTest.exported;
      return trace.version===6 && trace.assistance==='unassisted' && trace.exploration===null && !('position' in trace.observation.player) &&
        trace.observationPolicy.includes('not pixels/audio') && trace.records.some(r=>r.assistance==='assisted') &&
        trace.records.filter(r=>r.assistance==='unassisted').every(r=>!r.navigation && !('position' in r.before.player));
    `);
    await fresh();
    // Console commands execute on Host_Frame, not while the entire world is frozen.
    await evaluate("qev.respawner.enabled=true;assistanceTest.deaths=qev.respawner.count;qev.engine.play()");
    await bindKillForTest(); await killPlayerViaConsole();
    await until(() => evaluate("qev.respawner.count>assistanceTest.deaths && !qev.respawner.pending && qev.engine.snapshot().alive"));
    await check("death recovery preserves assistance-off rather than silently restoring aids", `
      return qev.engine.snapshot().assistance==='unassisted' && document.querySelector('#assistance').value==='unassisted' &&
        qev.engine.snapshot().paused && !('position' in qev.engine.snapshot().player);
    `);
  } finally {
    await evaluate(`qev.pause();qev.agent.invalidate();qev.engine.probe=assistanceTest.probe;qev.agent.getModel=assistanceTest.getModel;
      qev.respawner.enabled=assistanceTest.respawns;for(const job of assistanceTest.calls)job.resolve([])`);
  }
  await until(() => evaluate("!qev.agent.busy"));
  await mode('assisted'); await fresh();
  await evaluate("(async()=>{qev.agent.history.length=0;qev.agent.invalidate();for(let i=0;i<90&&!qev.engine.snapshot().player.grounded;i++)await qev.engine.frame();qev.pause();document.activeElement.blur();delete window.assistanceTest})()");
}

/** Two short, fresh-map real-model episodes. Illustrative, not matched-RNG or human-parity evidence. */
export async function runAssistanceTrials({ evaluate, check, until, onStopped = async () => {}, durationMs = 12_000 }) {
  const runs = [];
  await evaluate(`window.aidTrial={model:qev.model,mode:qev.assistance,level:{map:qev.engine.snapshot().map,difficulty:qev.engine.snapshot().difficulty},
    respawns:qev.respawner.enabled,onChange:qev.agent.onChange,probe:qev.engine.probe};qev.pause();qev.respawner.enabled=false;qev.engine.speed(1)`);
  try {
    for (const mode of ['assisted', 'unassisted']) {
      await evaluate(`qev.engine.probe=aidTrial.probe;document.querySelector('#assistance').value=${JSON.stringify(mode)};document.querySelector('#assistance').dispatchEvent(new Event('change',{bubbles:true}));
        document.querySelector('#map').value='lq_e0m6';document.querySelector('#difficulty').value='2';document.querySelector('#map').dispatchEvent(new Event('change',{bubbles:true}))`);
      await until(() => evaluate("qev.engine.snapshot().ready && qev.engine.snapshot().alive && !document.querySelector('#auto').disabled && !qev.agent.busy"));
      await evaluate(`aidTrial.records=new Map();aidTrial.firstId=qev.agent.sequence;aidTrial.start=qev.engine.snapshot();
        qev.agent.onChange=()=>{const r=qev.agent.current;if(r&&r.id>aidTrial.firstId)aidTrial.records.set(r.id,r);aidTrial.onChange();};
        ${mode === 'unassisted' ? "qev.engine.probe=()=>{throw new Error('Real unassisted trial queried geometry');};" : ""}
        aidTrial.started=performance.now();document.querySelector('#auto').click()`);
      const started = Date.now();
      while (Date.now() - started < durationMs) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (await evaluate("!qev.engine.snapshot().alive || qev.engine.snapshot().completed || qev.playMode!=='auto'")) break;
      }
      await evaluate("aidTrial.wallMs=performance.now()-aidTrial.started;aidTrial.end=qev.engine.snapshot();qev.pause()");
      await until(() => evaluate("!qev.agent.busy"), 30_000);
      await check(`real Laya ${mode} trial applies fresh decisions under the selected control boundary`, `
        const records=[...aidTrial.records.values()], raw=${mode === 'unassisted'};
        return qev.model===aidTrial.model && records.some(r=>r.appliedAt) && records.every(r=>r.assistance===${JSON.stringify(mode)}) &&
          records.filter(r=>r.appliedAt).every(r=>raw ? r.eligible[r.selectedIndex].params.input==='relative' && r.appliedGeometry===null && r.navigation===null && !('position' in r.before.player)
            : r.eligible[r.selectedIndex].params.input===undefined && r.appliedGeometry!==null) &&
          records.every(r=>!raw || Object.keys(r.requests[0].questions.action.criteria).length===14);
      `);
      const run = await evaluate(`(() => {
        const records=[...aidTrial.records.values()], applied=records.filter(r=>r.appliedAt), start=aidTrial.start, end=aidTrial.end;
        return {assistance:${JSON.stringify(mode)},map:start.map,difficulty:start.difficulty,wallMs:Math.round(aidTrial.wallMs),
          simulationTicks:end.tick-start.tick,alive:end.alive,completed:end.completed,healthStart:start.player.health,healthEnd:end.player.health,
          ammoStart:start.player.ammo,ammoEnd:end.player.ammo,decisions:records.length,applied:applied.length,
          choices:applied.map(r=>r.eligible[r.selectedIndex].id),start,end,records};
      })()`);
      runs.push(run);
      await onStopped(mode);
      await evaluate("qev.agent.onChange=aidTrial.onChange;qev.engine.probe=aidTrial.probe");
    }
    return { model: await evaluate("qev.model.info"), requestedWallMs: durationMs,
      caveat: "One fresh-start episode per mode with different observation/action interfaces and uncontrolled RNG. Engine object labels remain; this is not screen-only human parity or a reliable performance benchmark.", runs };
  } finally {
    await evaluate(`qev.pause();qev.agent.onChange=aidTrial.onChange;qev.engine.probe=aidTrial.probe;
      document.querySelector('#assistance').value=aidTrial.mode;document.querySelector('#assistance').dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('#map').value=aidTrial.level.map;document.querySelector('#difficulty').value=String(aidTrial.level.difficulty);document.querySelector('#map').dispatchEvent(new Event('change',{bubbles:true}))`);
    await until(() => evaluate("qev.engine.snapshot().ready && qev.engine.snapshot().alive && !document.querySelector('#map').disabled"));
    await evaluate("qev.respawner.enabled=aidTrial.respawns;delete window.aidTrial");
  }
}
