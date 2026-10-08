// Real SDL/Web Audio output checks, called by browser-smoke. No tones or game
// sounds are fabricated: sample the buffers after the native mixer fills them.
export async function beginAudioChecks({ check }) {
  await check("the sound device initializes while automatic startup remains stopped and silent", `
    const sdl=qev.engine.module.SDL2, context=sdl?.audioContext, node=sdl?.audio?.scriptProcessorNode;
    if(!context || !node || context.state==='closed') throw new Error('SDL Web Audio device was not initialized');
    window.audioMeter={context,node,callbacks:0,peak:0,invalid:0,resumes:0,
      reset(){this.callbacks=0;this.peak=0;this.invalid=0;}};
    audioMeter.fill=node.onaudioprocess;
    node.onaudioprocess=function(event){
      audioMeter.fill.call(this,event);
      audioMeter.callbacks++;
      for(let c=0;c<event.outputBuffer.numberOfChannels;c++) {
        for(const value of event.outputBuffer.getChannelData(c)) {
          if(!Number.isFinite(value) || Math.abs(value)>1) audioMeter.invalid++;
          else audioMeter.peak=Math.max(audioMeter.peak,Math.abs(value));
        }
      }
    };
    audioMeter.resume=context.resume;
    context.resume=function(...args){audioMeter.resumes++;return audioMeter.resume.apply(this,args);};
    const before=qev.engine.snapshot();
    await new Promise(r=>setTimeout(r,250));
    return before.paused && qev.engine.snapshot().tick===before.tick && audioMeter.peak===0 && audioMeter.invalid===0 &&
      context.sampleRate>0;
  `);
}

export async function checkAudioPlayback({ evaluate, check, call, until }) {
  const click = async id => {
    const point=await evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)});if(e.disabled)throw new Error('Disabled audio test button');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
  };
  await evaluate(`
    window.audioOriginalModel=qev.agent.getModel;
    window.audioCalls=[];
    window.audioModel={info:{backend:'audio-regression'},decideMany(requests){return new Promise(resolve=>audioCalls.push({requests,resolve,done:false}));}};
    qev.agent.getModel=()=>audioModel;
    window.answerAudioCall=()=>{
      const job=audioCalls.at(-1);if(!job || job.done)return;
      job.done=true;
      const keys=Object.keys(job.requests[0].questions.action.criteria), choice=keys.find(k=>k.startsWith('fire-')) || keys[0];
      job.resolve([{answers:{action:{type:'choice',choice,probabilities:Object.fromEntries(keys.map(k=>[k,k===choice?1:0]))}}}]);
    };
  `);
  const stop = async () => {
    await evaluate("qev.pause();answerAudioCall()");
    await until(()=>evaluate("!qev.agent.busy"));
  };
  const quiet = label => check(label, `
    const before=qev.engine.snapshot();audioMeter.reset();
    await new Promise(r=>setTimeout(r,250));
    return before.paused && qev.engine.snapshot().tick===before.tick && audioMeter.context.state==='running' &&
      audioMeter.callbacks>0 && audioMeter.peak===0 && audioMeter.invalid===0;
  `);
  try {
    // Autoplay may still be blocked, or earlier interactions may have unlocked SDL.
    // Start must explicitly resume a suspended context in either case.
    await evaluate("qev.agent.invalidate();audioMeter.reset();window.audioBefore=qev.engine.snapshot();window.audioResumeCount=audioMeter.resumes;void audioMeter.context.suspend()");
    await until(()=>evaluate("audioMeter.context.state==='suspended' && !document.querySelector('#auto').disabled"));
    await click("auto");
    await until(()=>evaluate("qev.agent.busy && audioMeter.context.state==='running'"));
    await check("a trusted Start click resumes browser audio without waiting for inference", `
      return audioMeter.resumes>audioResumeCount && !qev.engine.snapshot().paused && qev.agent.current.status==='scoring';
    `);
    await evaluate("answerAudioCall()");
    await until(()=>evaluate("qev.engine.snapshot().player.ammo<audioBefore.player.ammo && audioMeter.peak>0.00001"));
    await check("actual firing produces finite nonzero samples through SDL's connected output", `
      return audioMeter.context.state==='running' && audioMeter.callbacks>0 && audioMeter.peak>0.00001 && audioMeter.invalid===0;
    `);
    await click("pause"); await stop();
    await quiet("Stop silences the native mixer even while the AudioContext remains unlocked");

    await evaluate("audioMeter.reset();qev.agent.invalidate();qev.engine.loadMap('qev_encounter')");
    await until(()=>evaluate("qev.engine.snapshot().ready && qev.engine.snapshot().paused && !document.querySelector('#step').disabled"));
    await check("map loading keeps the existing audio context and emits no old-world sound", `
      return audioMeter.context===qev.engine.module.SDL2.audioContext && audioMeter.peak===0 && audioMeter.invalid===0;
    `);
    await evaluate("window.audioBefore=qev.engine.snapshot();window.audioResumeCount=audioMeter.resumes;audioMeter.reset();void audioMeter.context.suspend()");
    await until(()=>evaluate("audioMeter.context.state==='suspended'"));
    await click("step");
    await until(()=>evaluate("qev.agent.busy && audioMeter.context.state==='running'"));
    await quiet("Step unlocks audio before asynchronous scoring but stays silent throughout stopped inference");
    await check("the Step click issued the resume while retaining its frozen observation", `
      return audioMeter.resumes>audioResumeCount && qev.engine.snapshot().tick===audioBefore.tick;
    `);
    await evaluate("answerAudioCall()");
    await until(()=>evaluate("!qev.agent.busy && qev.agent.current?.status==='executed'"));
    await check("a single Step emits real game audio during its action and still executes exactly twelve ticks", `
      const after=qev.engine.snapshot();
      if(!(after.tick===audioBefore.tick+12 && after.player.ammo<audioBefore.player.ammo && audioMeter.peak>0.00001 && audioMeter.invalid===0))
        throw new Error('Audio Step: '+JSON.stringify({before:audioBefore,after,peak:audioMeter.peak,callbacks:audioMeter.callbacks,invalid:audioMeter.invalid,decision:qev.agent.current}));
      return true;
    `);
    await quiet("finishing a Step silences output without needing another user gesture");

    await evaluate("window.audioBefore=qev.engine.snapshot();void audioMeter.context.suspend();document.querySelector('#game').focus({preventScroll:true})");
    await until(()=>evaluate("audioMeter.context.state==='suspended' && !document.querySelector('#step').disabled"));
    await call("Input.dispatchKeyEvent", { type: "keyDown", key: "n", code: "KeyN", windowsVirtualKeyCode: 78, text: "n" });
    await call("Input.dispatchKeyEvent", { type: "keyUp", key: "n", code: "KeyN", windowsVirtualKeyCode: 78 });
    await until(()=>evaluate("qev.agent.busy && audioMeter.context.state==='running'"));
    await quiet("the N shortcut also unlocks audio while its pending decision remains silent");
    await stop();
    await check("Stop during keyboard-triggered scoring cannot be undone by an audio unlock or late reply", `
      return qev.engine.snapshot().paused && qev.engine.snapshot().tick===audioBefore.tick;
    `);

    await evaluate("audioMeter.reset()");
    await click("auto");
    await until(()=>evaluate("qev.agent.busy")); await evaluate("answerAudioCall()");
    await until(()=>evaluate("audioMeter.peak>0.00001"));
    await evaluate("dispatchEvent(new Event('blur'));answerAudioCall()");
    await until(()=>evaluate("!qev.agent.busy"));
    await quiet("focus loss stops both simulation and sound");

    await evaluate("audioMeter.context.resume=()=>Promise.reject(new Error('Test-only browser audio refusal'));void audioMeter.context.suspend()");
    await until(()=>evaluate("audioMeter.context.state==='suspended' && !document.querySelector('#auto').disabled"));
    await click("auto");
    await until(()=>evaluate("qev.agent.busy && !document.querySelector('#error').hidden"));
    await check("audio refusal is reported without blocking game control or the Stop button", `
      const before=qev.engine.snapshot();await new Promise(r=>setTimeout(r,150));
      return !before.paused && qev.engine.snapshot().tick>before.tick && !document.querySelector('#pause').disabled &&
        document.querySelector('#error').textContent.includes('Sound could not start');
    `);
    await stop();
  } finally {
    await stop();
    await evaluate(`(async()=>{
      audioMeter.context.resume=audioMeter.resume;
      audioMeter.node.onaudioprocess=audioMeter.fill;
      qev.agent.getModel=audioOriginalModel;qev.agent.invalidate();
      await qev.engine.loadMap('qev_encounter');
      for(let i=0;i<90 && !qev.engine.snapshot().player.grounded;i++)await qev.engine.frame();
      document.querySelector('#error').hidden=true;scrollTo(0,0);
    })()`);
  }
}
