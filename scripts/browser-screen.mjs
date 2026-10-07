// Real-renderer checks, called only by the --mute-audio-enforced browser harness.
// Console bindings below are test-only render controls; no production cheat API is added.
export async function checkScreen({ evaluate, check, until, pressKeys }) {
  const mode = value => evaluate(`document.querySelector('#assistance').value=${JSON.stringify(value)};document.querySelector('#assistance').dispatchEvent(new Event('change',{bubbles:true}))`);
  const fresh = async () => {
    await evaluate("qev.pause();document.querySelector('#map').value='qev_encounter';document.querySelector('#difficulty').value='0';document.querySelector('#map').dispatchEvent(new Event('change',{bubbles:true}))");
    await until(() => evaluate("qev.engine.snapshot().ready && qev.engine.snapshot().alive && !document.querySelector('#map').disabled"));
  };
  const key = async letter => {
    await pressKeys([[letter, 'Key' + letter.toUpperCase(), letter.toUpperCase().charCodeAt(0)]]);
    await evaluate("qev.engine.frame()");
  };
  await evaluate("window.screenTest={respawns:qev.respawner.enabled};qev.respawner.enabled=false");
  try {
    // Install bindings via the actual Quake console, then reload a stopped fresh arena.
    await evaluate(`qev.pause();qev.engine.module.FS.writeFile('/id1/qevscreen.cfg',
      'bind v "fov 120"\\nbind f "fov 90"\\nbind b "r_drawentities 0"\\nbind c "r_drawentities 1"\\nbind g "r_drawflat 1"\\nbind h "r_drawflat 0"\\nbind j "echo score; +showscores"\\nbind k "-showscores"\\nbind l "god"\\n');qev.engine.play()`);
    await pressKeys([[String.fromCharCode(96), 'Backquote', 192]]);
    await new Promise(r => setTimeout(r, 120));
    const keys = [...'exec qevscreen.cfg'].map(c => [c, c === ' ' ? 'Space' : c === '.' ? 'Period' : 'Key' + c.toUpperCase(), c === ' ' ? 32 : c === '.' ? 190 : c.toUpperCase().charCodeAt(0)]);
    await pressKeys([...keys, ['Enter', 'Enter', 13]]);
    await new Promise(r => setTimeout(r, 120));
    await pressKeys([[String.fromCharCode(96), 'Backquote', 192]]);
    await evaluate("qev.pause()");
    await fresh(); await key('l'); await mode('unassisted');
    await check("frozen Off snapshots measure the already rendered frame without moving time or reprojecting an entity box", `
      const s=qev.engine.snapshot();screenTest.first=s;
      const frame=s.screen;
      if(!frame.available || !s.enemies.length)throw new Error(JSON.stringify(s));
      await new Promise(r=>setTimeout(r,120));const now=qev.engine.snapshot();
      return s.version===3 && frame.source==='renderer-visible-pixels' && frame.tick===s.tick &&
        frame.viewport.join(',')==='0,0,640,432' && now.screen.frame===frame.frame && now.tick===s.tick &&
        s.enemies.every(e=>e.screen.pixels>0 && e.screen.bounds.every(n=>n>=0 && n<=1) &&
          ['distance','range','bearing','elevation','slot','generation','position'].every(k=>!(k in e)));
    `);
    await key('v');
    await check("widening the rendered FOV makes the apparent target smaller, without supplying a metric distance", `
      const a=screenTest.first.enemies.find(e=>e.kind==='monster_army'), s=qev.engine.snapshot(), b=s.enemies.find(e=>e.kind==='monster_army');
      if(!b || (b.screen.bounds[3]-b.screen.bounds[1])>=(a.screen.bounds[3]-a.screen.bounds[1])*0.85)throw new Error(JSON.stringify({a,b,s}));
      return s.screen.available && s.screen.frame>screenTest.first.screen.frame && s.tick-screenTest.first.tick===1 &&
        b.screen.pixels<a.screen.pixels && !('distance' in b);
    `);
    await key('f'); await key('b');
    await check("actors excluded from rendering disappear from Off perception even if the engine LOS sensor would see them", `
      const s=qev.engine.snapshot();screenTest.notDrawn=s;
      return s.screen.available && s.enemies.length===0 && s.pickups.length===0;
    `);
    await mode('assisted');
    await check("the draw-disabled control scene still has a live LOS-visible enemy in privileged assisted telemetry", `
      const s=qev.engine.snapshot();return s.enemies.some(e=>e.kind==='monster_army') && s.tick===screenTest.notDrawn.tick;
    `);
    await mode('unassisted'); await key('c');
    await check("reenabling actual entity drawing restores pixel cues, including true pixel coverage at the aim point", `
      const s=qev.engine.snapshot();return s.screen.available && s.enemies.length>0 &&
        s.enemies.every(e=>typeof e.screen.aimOverlap==='boolean' && e.screen.pixels>0 && e.screen.sameKindCount>=1);
    `);
    await key('j');
    await check("unmeasured scoreboard overlays suppress scene cues rather than exposing a covered view", `
      const s=qev.engine.snapshot();return !s.screen.available && s.screen.reason==='Player view covered' && !s.enemies.length;
    `);
    await key('k');
    await key('g');
    await check("unsupported debug rendering fails closed instead of falling back to world-derived depth", `
      const s=qev.engine.snapshot(), {prepareDecision}=await import('/src/decisions.js');
      const r=prepareDecision(s,()=>{throw new Error('Unexpected probe')});
      return !s.screen.available && /Unsupported debug render/.test(s.screen.reason) && s.enemies.length===0 &&
        r.eligible.length===14 && r.sharedState.includes('Screen cues unavailable');
    `);
    await key('h');
    await evaluate(`(async()=>{for(let i=0;i<2;i++){const s=qev.engine.snapshot();await qev.engine.act({input:'relative',epoch:s.epoch,tick:s.tick,forward:0,side:0,yawRate:180,pitchRate:45,fire:false,ticks:12});}})()`);
    await check("brush-model pickups also get extents from drawn spans, not a projected world-space box", `
      const s=qev.engine.snapshot();
      if(!s.pickups.some(e=>e.kind==='health' && e.screen.pixels>0))throw new Error(JSON.stringify(s));
      return s.screen.available && s.pickups.every(e=>e.screen.bounds.length===4 && !('range' in e));
    `);
  } finally {
    await evaluate("qev.pause()");
    for (const letter of ['f', 'c', 'h', 'k']) await key(letter);
    await mode('assisted'); await fresh();
    await evaluate("qev.engine.module.FS.unlink('/id1/qevscreen.cfg');qev.respawner.enabled=screenTest.respawns;qev.agent.invalidate();delete window.screenTest;document.activeElement.blur()");
  }
}

/** Synthetic text-budget stress only. Never execute it or present it as gameplay. */
export async function checkScreenModel({ evaluate, check }) {
  const report = await evaluate(`(async()=>{
    const {prepareDecision}=await import('/src/decisions.js');
    const object=kind=>({kind,visible:true,screen:{bounds:[0,0,0.9123,0.8345],pixels:12345,aimOverlap:true,clipped:true,sameKindCount:1}});
    const s={ready:true,alive:true,completed:false,assistance:'unassisted',epoch:1,tick:10,
      screen:{source:'renderer-visible-pixels',available:true,frame:10,tick:10,viewport:[0,0,640,432],distorted:false},
      player:{health:123,armor:200,ammo:125,weapon:'double shotgun',silverKey:true,goldKey:true},
      enemies:['monster_army','monster_shalrath','monster_enforcer'].map(object),
      pickups:['weapon_supershotgun','weapon_supernailgun','gold_key'].map(object)};
    const prepared=prepareDecision(s,()=>{throw new Error('Unexpected probe')},{epoch:1,label:'Strafe right and fire',damage:32,ammoChange:-12},
      {realtime:true,heldAction:'Strafe right and fire'});
    const responses=await qev.model.decideMany(prepared.requests);
    return {synthetic:true,purpose:'Dense six-object screen-cue input budget only, not gameplay or an accuracy benchmark',
      requests:prepared.requests,responses};
  })()`);
  await check("screen-cue budget probing leaves the game stopped", `return qev.engine.snapshot().paused && !qev.agent.busy;`);
  const tokens = report.responses[0]?.usage?.input_tokens;
  if (!Number.isFinite(tokens) || tokens >= 512) throw new Error(`Dense screen-cue prompt reached Laya's input limit: ${tokens}`);
  console.log(`PASS synthetic six-object screen-cue request fits Laya's input window (${tokens} tokens)`);
  return report;
}
