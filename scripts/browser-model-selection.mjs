// UI loading lifecycle checks against the real app/engine with a deliberately
// delayed SDK loader. No model weights are fetched by this helper.
export async function checkModelSelection({ evaluate, check, until }) {
  const change = (id, value) => evaluate(`(() => {
    const select=document.getElementById(${JSON.stringify(id)});
    select.value=${JSON.stringify(value)};select.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  const idle = () => until(() => evaluate("!document.querySelector('#model').disabled"));
  const loadCount = count => until(() => evaluate(`modelSelectionTest.loads.length===${count}`));
  await check("the initially unfocused model dropdown highlights a required choice, with no Load button or dialog", `
    const select=document.querySelector('#model'), style=getComputedStyle(select);
    return select.value==='' && select.required && select.selectedOptions[0].textContent==='Choose a decision model' &&
      select.selectedOptions[0].disabled && document.activeElement!==select &&
      select.closest('.model-setting').classList.contains('needs-selection') &&
      style.borderTopColor==='rgb(198, 245, 130)' && style.boxShadow!=='none' && style.animationName==='none' &&
      select.getAttribute('aria-describedby')==='model-status' &&
      document.querySelector('#model-status').textContent.includes('selecting downloads it if needed') &&
      !document.querySelector('#load-model, #model-required') && document.querySelector('#step').disabled && !qev.model;
  `);
  await until(() => evaluate("!document.querySelector('#auto').disabled"));
  await evaluate(`(async () => {
    const {Kevala}=await import('/vendor/kevala/index.js');
    window.modelSelectionTest={Kevala,originalLoad:Kevala.load,loads:[],decisions:[],before:qev.engine.snapshot()};
    Kevala.load=options=>new Promise((resolve,reject)=>modelSelectionTest.loads.push({options,resolve,reject}));
    modelSelectionTest.finish=index=>{
      const job=modelSelectionTest.loads[index];
      job.model={info:{model:job.options.model,backend:job.options.backend,arch:'selection-regression'},disposed:0,
        dispose(){this.disposed++;},
        decideMany(requests){return new Promise(resolve=>modelSelectionTest.decisions.push({requests,resolve}));}};
      job.resolve(job.model);
    };
  })()`);
  try {
    await evaluate("document.querySelector('[data-priority=get-supplies] [data-move=up]').click();modelSelectionTest.priorityOrder=[...qev.priorityOrder]");
    await evaluate("document.querySelector('#auto').click()");
    await check("Start without a model focuses the highlighted dropdown without downloading or playing", `
      return document.activeElement===document.querySelector('#model') && document.querySelector('#model').value==='' &&
        document.querySelector('#model-status').textContent.includes('Choose Kev or Laya') && !qev.model &&
        modelSelectionTest.loads.length===0 && qev.engine.snapshot().paused && qev.engine.snapshot().tick===modelSelectionTest.before.tick;
    `);
    await change('backend', 'wasm');
    await evaluate(`document.querySelector('#model').add(new Option('Unknown model','unknown',false,true));
      document.querySelector('#model').dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('#model option[value="unknown"]').remove()`);
    await change('model', '');
    await check("backend preferences and empty/unknown model changes never download a default model", `
      return modelSelectionTest.loads.length===0 && !qev.model && document.querySelector('#model').value==='' &&
        document.querySelector('#backend').value==='wasm' && document.querySelector('#model-progress').hidden;
    `);
    await evaluate(`document.querySelector('#model').value='laya';
      document.querySelector('#model').dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('#cancel-model').click()`);
    await idle();
    await check("cancellation during the asynchronous SDK import prevents the download from starting", `
      return modelSelectionTest.loads.length===0 && !qev.model && document.querySelector('#model').value==='' &&
        document.querySelector('#model-status').textContent.includes('cancelled');
    `);
    await change('model', 'laya'); await loadCount(1);
    await check("selecting Laya immediately starts one load with the chosen backend and blocks playback", `
      const job=modelSelectionTest.loads[0], select=document.querySelector('#model');
      return job.options.model==='laya' && job.options.backend==='wasm' && !job.options.signal.aborted &&
        select.value==='laya' && select.disabled && document.querySelector('#backend').disabled &&
        !select.closest('.model-setting').classList.contains('needs-selection') &&
        document.querySelector('#model-status').textContent.includes('Laya · 479 MB') &&
        document.querySelector('#auto').disabled && document.querySelector('#step').disabled &&
        !document.querySelector('#cancel-model').hidden && !document.querySelector('#model-progress').hidden &&
        !document.querySelector('#model-progress').hasAttribute('value') && qev.engine.snapshot().paused && !qev.model;
    `);
    await check("the selected model's progress updates the existing status and progress bar", `
      modelSelectionTest.loads[0].options.onProgress({phase:'download',message:'Selected model download',loaded:20,total:100});
      return document.querySelector('#model-status').textContent==='Selected model download' &&
        document.querySelector('#model-progress').max===100 && document.querySelector('#model-progress').value===20;
    `);
    await change('model', 'kev-0.8b'); await change('backend', 'auto');
    await check("forced changes to disabled selectors cannot overlap loads or mislabel the active download", `
      return modelSelectionTest.loads.length===1 && document.querySelector('#model').value==='laya' &&
        document.querySelector('#backend').value==='wasm';
    `);
    await evaluate("document.querySelector('#cancel-model').click()");
    await check("Cancel aborts the download and ignores subsequent progress callbacks", `
      modelSelectionTest.loads[0].options.onProgress({message:'STALE cancelled progress',loaded:99,total:100});
      return modelSelectionTest.loads[0].options.signal.aborted && document.querySelector('#cancel-model').disabled &&
        document.querySelector('#model-status').textContent==='Cancelling model download…';
    `);
    await evaluate("modelSelectionTest.finish(0)"); await idle();
    await check("a late successful load after Cancel is disposed and restores the highlighted placeholder", `
      return modelSelectionTest.loads[0].model.disposed===1 && !qev.model && document.querySelector('#model').value==='' &&
        document.querySelector('.model-setting').classList.contains('needs-selection') &&
        document.querySelector('#model-progress').hidden && document.querySelector('#cancel-model').hidden &&
        document.querySelector('#model-status').textContent.includes('cancelled') && document.querySelector('#error').hidden;
    `);
    await change('model', 'laya'); await loadCount(2);
    await evaluate("modelSelectionTest.loads[1].reject(new Error('selection-regression failure'))"); await idle();
    await check("a failed load also resets the choice, reports the failure, and permits a same-model retry", `
      return !qev.model && document.querySelector('#model').value==='' &&
        document.querySelector('.model-setting').classList.contains('needs-selection') && document.querySelector('#step').disabled &&
        document.querySelector('#model-status').textContent.includes('selection-regression failure') &&
        document.querySelector('#model-status').textContent.includes('Select a model to retry') && !document.querySelector('#error').hidden;
    `);
    await change('model', 'laya'); await loadCount(3);
    await check("late progress from cancelled or failed jobs cannot overwrite a retry", `
      const status=document.querySelector('#model-status').textContent;
      for(const job of modelSelectionTest.loads.slice(0,2)) job.options.onProgress({message:'STALE previous attempt'});
      return document.querySelector('#model-status').textContent===status && document.querySelector('#error').hidden;
    `);
    await evaluate("document.querySelector('#pause').click();modelSelectionTest.finish(2)"); await idle();
    await check("successful loading removes the highlight but never automatically starts or steps the game", `
      const ready=document.querySelector('#model-status').textContent;
      modelSelectionTest.loads[2].options.onProgress({message:'STALE finished progress'});
      return qev.model===modelSelectionTest.loads[2].model && qev.model.disposed===0 &&
        document.querySelector('#model').value==='laya' && !document.querySelector('.model-setting').classList.contains('needs-selection') &&
        document.querySelector('#model-status').textContent===ready && ready.includes('laya ready · wasm') &&
        !document.querySelector('#auto').disabled && !document.querySelector('#step').disabled &&
        document.querySelector('#auto').getAttribute('aria-pressed')==='false' && modelSelectionTest.decisions.length===0 &&
        qev.engine.snapshot().paused && qev.engine.snapshot().tick===modelSelectionTest.before.tick && qev.playMode==='inspection';
    `);
    await change('backend', 'auto'); await loadCount(4);
    await check("changing the backend reloads the selected model and disposes the old instance", `
      return modelSelectionTest.loads[3].options.model==='laya' && modelSelectionTest.loads[3].options.backend==='auto' &&
        modelSelectionTest.loads[2].model.disposed===1 && !qev.model && qev.engine.snapshot().paused;
    `);
    await evaluate("modelSelectionTest.finish(3)"); await idle();
    await evaluate("document.querySelector('#auto').click()");
    await until(() => evaluate("modelSelectionTest.decisions.length===1 && qev.agent.busy && !qev.engine.snapshot().paused"));
    await evaluate("modelSelectionTest.oldDecision=qev.agent.current");
    await change('model', 'kev-0.8b'); await loadCount(5);
    await check("changing models during inference stops the world, invalidates the old decision, and loads Kev", `
      modelSelectionTest.stopped=qev.engine.snapshot();
      return modelSelectionTest.loads[4].options.model==='kev-0.8b' && modelSelectionTest.loads[3].model.disposed===1 &&
        !qev.model && !qev.agent.current && modelSelectionTest.oldDecision.status==='cancelled' &&
        qev.engine.snapshot().paused && qev.playMode==='inspection' && document.querySelector('#auto').getAttribute('aria-pressed')==='false';
    `);
    await evaluate("modelSelectionTest.finish(4)"); await idle();
    await check("a replacement model cannot enable playback while obsolete inference is still settling", `
      return qev.model===modelSelectionTest.loads[4].model && document.querySelector('#auto').disabled && document.querySelector('#step').disabled;
    `);
    await evaluate(`(() => {
      const job=modelSelectionTest.decisions[0], keys=Object.keys(job.requests[0].questions.action.criteria);
      job.resolve([{answers:{action:{type:'choice',choice:keys[0],probabilities:Object.fromEntries(keys.map((key,i)=>[key,i===0?1:0]))}}}]);
    })()`);
    await until(() => evaluate("!qev.agent.busy && !document.querySelector('#auto').disabled"));
    await check("the previous model's late answer is discarded and cannot restart play with the replacement", `
      return modelSelectionTest.oldDecision.status==='discarded' && !modelSelectionTest.oldDecision.appliedAt &&
        qev.engine.snapshot().paused && qev.engine.snapshot().tick===modelSelectionTest.stopped.tick && qev.playMode==='inspection' &&
        qev.model===modelSelectionTest.loads[4].model && document.querySelector('#model').value==='kev-0.8b';
    `);
    await change('backend', 'wasm'); await loadCount(6);
    await evaluate("document.querySelector('#cancel-model').click();modelSelectionTest.loads[5].reject(new DOMException('Aborted','AbortError'))"); await idle();
    await check("model switches and backend reloads keep the user's configured priorities", `
      return JSON.stringify(qev.priorityOrder)===JSON.stringify(modelSelectionTest.priorityOrder) &&
        JSON.stringify(modelSelectionTest.oldDecision.priorityOrder)===JSON.stringify(modelSelectionTest.priorityOrder);
    `);
    await check("normal cancellation rejection also leaves a retryable choice rather than an error", `
      return !qev.model && modelSelectionTest.loads[4].model.disposed===1 && document.querySelector('#model').value==='' &&
        document.querySelector('#model-status').textContent.includes('cancelled') && document.querySelector('#error').hidden;
    `);
  } finally {
    await evaluate(`qev.pause();qev.agent.invalidate();modelSelectionTest.Kevala.load=modelSelectionTest.originalLoad;
      for(const job of modelSelectionTest.decisions)job.resolve([])`);
  }
  // Restore a pristine stopped map/empty history for the remaining browser tests.
  // Only this test fixture clears history; production model changes preserve it.
  await change('model', ''); await change('backend', 'auto');
  await evaluate("document.querySelector('#reset-priorities').click();qev.agent.history.length=0;qev.agent.invalidate();qev.engine.loadMap('lq_e0m6',2)");
  await evaluate("qev.pause();document.activeElement.blur();delete window.modelSelectionTest");
}
