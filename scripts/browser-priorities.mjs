// Reordering and prompt lifecycle checks against the real UI/engine. Inference is
// deliberately delayed here so priority edits can race with old model responses.
export async function checkPriorities({ evaluate, check, until, call, dragEvents }) {
  const up = id => evaluate(`document.querySelector('[data-priority="${id}"] [data-move="up"]').click()`);
  const choose = (id, value) => evaluate(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)};document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('change',{bubbles:true}))`);
  await check("priorities show the exact four prompt objectives in order with accessible reorder controls", `
    const {PRIORITIES,DEFAULT_PRIORITY_ORDER}=await import('/src/objective.js');
    const rows=[...document.querySelectorAll('#priorities .priority-item')];
    return JSON.stringify(rows.map(row=>row.dataset.priority))===JSON.stringify(DEFAULT_PRIORITY_ORDER) &&
      JSON.stringify(qev.priorityOrder)===JSON.stringify(DEFAULT_PRIORITY_ORDER) &&
      rows.every((row,i)=>row.querySelector('.priority-copy p').textContent===PRIORITIES[i].prompt &&
        row.querySelector('.priority-copy strong').textContent===PRIORITIES[i].label && row.draggable &&
        [...row.querySelectorAll('button')].every(button=>button.type==='button' && button.getAttribute('aria-label').startsWith('Move '))) &&
      rows[0].querySelector('[data-move="up"]').disabled && rows.at(-1).querySelector('[data-move="down"]').disabled &&
      document.querySelector('#reset-priorities').disabled && document.querySelector('#priority-hint').textContent.includes('Reordering stops play') &&
      document.querySelector('.priority-note').textContent.includes('survival-biased action offers stay fixed');
  `);
  await evaluate("document.querySelector('[data-priority=explore] [data-move=up]').focus({preventScroll:true})");
  await up('explore');
  await check("an arrow moves a priority without selecting a model, starting play, or losing keyboard focus", `
    return qev.priorityOrder.join(',')==='avoid-harm,get-supplies,explore,handle-threats' &&
      document.activeElement.closest('.priority-item').dataset.priority==='explore' && !document.activeElement.disabled &&
      document.querySelector('#priority-status').textContent.includes('priority 3 of 4') &&
      !qev.model && qev.engine.snapshot().paused && !document.querySelector('#reset-priorities').disabled;
  `);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', modifiers: 1, windowsVirtualKeyCode: 38 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', modifiers: 1, windowsVirtualKeyCode: 38 });
  await check("Alt+Up also reorders the focused priority using the keyboard", `
    return qev.priorityOrder.join(',')==='avoid-harm,explore,get-supplies,handle-threats' &&
      document.activeElement.closest('.priority-item').dataset.priority==='explore';
  `);
  await check("external drag payloads cannot silently replace the priority configuration", `
    const before=qev.priorityOrder.join(','), dataTransfer=new DataTransfer();dataTransfer.setData('text/plain','explore');
    document.querySelector('[data-priority=avoid-harm]').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer}));
    return qev.priorityOrder.join(',')===before;
  `);
  const points = await evaluate(`(() => {
    const from=document.querySelector('[data-priority=explore] .priority-grip').getBoundingClientRect();
    const to=document.querySelector('[data-priority=avoid-harm]').getBoundingClientRect();
    return {from:{x:from.x+from.width/2,y:from.y+from.height/2},to:{x:to.x+to.width/2,y:to.y+to.height/2}};
  })()`);
  await evaluate(`window.priorityDragLog=[];window.priorityDragLogEvent=event=>{
    const entry={type:event.type,target:event.target.className,buttons:event.buttons,button:event.button,x:event.clientX,y:event.clientY};
    priorityDragLog.push(entry);queueMicrotask(()=>entry.prevented=event.defaultPrevented);
  };for(const type of ['mousedown','mousemove','dragstart','dragend','drop'])document.querySelector('#priorities').addEventListener(type,priorityDragLogEvent)`);
  dragEvents.length = 0;
  await call('Input.setInterceptDrags', { enabled: true });
  try {
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...points.from });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...points.from });
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: points.from.x + 12, y: points.from.y - 12 });
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, ...points.to });
    const data = await until(() => dragEvents.shift(), 10_000);
    for (const type of ['dragEnter', 'dragOver', 'drop']) await call('Input.dispatchDragEvent', { type, data, ...points.to });
  } catch (error) {
    console.error('Drag diagnostics:', points, await evaluate("({events:priorityDragLog,scrollY,scale:visualViewport.scale,source:document.querySelector('[data-priority=explore]').outerHTML})"));
    throw error;
  } finally {
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...points.to });
    await call('Input.setInterceptDrags', { enabled: false });
    await evaluate("for(const type of ['mousedown','mousemove','dragstart','dragend','drop'])document.querySelector('#priorities').removeEventListener(type,priorityDragLogEvent);delete window.priorityDragLog;delete window.priorityDragLogEvent");
  }
  await check("native pointer drag/drop moves to the target rank and updates the displayed numbers", `
    const rows=[...document.querySelectorAll('#priorities .priority-item')];
    return qev.priorityOrder.join(',')==='explore,avoid-harm,get-supplies,handle-threats' &&
      rows.map(row=>row.dataset.priority).join(',')===qev.priorityOrder.join(',') &&
      rows.map(row=>row.querySelector('.priority-rank > span').textContent).join(',')==='1,2,3,4' &&
      !document.querySelector('.dragging,.drop-target');
  `);
  await evaluate(`window.priorityTest={getModel:qev.agent.getModel,calls:[],records:[]};
    priorityTest.model={info:{backend:'priority-regression'},decideMany(requests){return new Promise(resolve=>priorityTest.calls.push({requests,resolve}));}};
    qev.agent.getModel=()=>priorityTest.model;
    priorityTest.answer=index=>{
      const job=priorityTest.calls[index], keys=Object.keys(job.requests[0].questions.action.criteria);
      job.resolve([{answers:{action:{type:'choice',choice:keys[0],probabilities:Object.fromEntries(keys.map((key,i)=>[key,i===0?1:0]))}}}]);
    };
    qev.agent.invalidate()`);
  try {
    await evaluate("void qev.score();priorityTest.records.push(qev.agent.current)");
    await check("the real request and exact-state disclosure put exploration first when the user does", `
      const {goalPrompt}=await import('/src/objective.js'), record=priorityTest.records[0];
      const card=document.querySelector('[data-decision-id="'+record.id+'"]');
      priorityTest.originalState=record.requests[0].state;
      return record.priorityOrder.join(',')===qev.priorityOrder.join(',') && record.requests===priorityTest.calls[0].requests &&
        record.requests[0].state.startsWith(goalPrompt(qev.priorityOrder)) && record.objectives[0].startsWith('Explore') &&
        card.querySelector('[data-payload=state]').textContent===record.requests[0].state &&
        !/only after survival needs|Exploration is secondary/.test(JSON.stringify(record.requests));
    `);
    await up('avoid-harm');
    await evaluate("priorityTest.answer(0)");
    await until(() => evaluate("!qev.agent.busy"));
    await check("reordering discards an outstanding inspection answer without rewriting its old state or priorities", `
      const record=priorityTest.records[0], card=document.querySelector('[data-decision-id="'+record.id+'"]');
      return record.status==='discarded' && !record.appliedAt && qev.engine.snapshot().paused &&
        record.priorityOrder[0]==='explore' && qev.priorityOrder[0]==='avoid-harm' &&
        record.requests[0].state===priorityTest.originalState && card.querySelector('[data-payload=state]').textContent===priorityTest.originalState;
    `);
    await evaluate("void qev.score();priorityTest.records.push(qev.agent.current);priorityTest.answer(1)");
    await until(() => evaluate("!qev.agent.busy"));
    await check("the next decision uses the new order while older cards keep the old one", `
      const {goalPrompt}=await import('/src/objective.js'), record=priorityTest.records[1];
      return record.status==='scored' && record.requests[0].state.startsWith(goalPrompt(qev.priorityOrder)) &&
        record.priorityOrder.join(',')==='avoid-harm,explore,get-supplies,handle-threats' &&
        priorityTest.records[0].priorityOrder[0]==='explore';
    `);
    await evaluate("document.querySelector('#reset-priorities').focus({preventScroll:true});document.querySelector('#reset-priorities').click()");
    await check("Reset restores defaults and invalidates even a frozen scored action without losing focus", `
      return qev.priorityOrder.join(',')==='avoid-harm,get-supplies,handle-threats,explore' && !qev.agent.current &&
        priorityTest.records[1].status==='cancelled' && document.querySelector('#reset-priorities').disabled &&
        document.activeElement.closest('.priority-item').dataset.priority==='avoid-harm' && !document.activeElement.disabled;
    `);
    await until(() => evaluate("!document.querySelector('#step').disabled"));
    await evaluate("document.querySelector('#step').click();priorityTest.records.push(qev.agent.current);priorityTest.beforeStep=qev.engine.snapshot()");
    await up('get-supplies');
    await evaluate("priorityTest.answer(2)");
    await until(() => evaluate("!qev.agent.busy"));
    await check("a priority edit during UI Step scoring cannot let the old answer execute", `
      return priorityTest.records[2].status==='discarded' && qev.engine.snapshot().paused &&
        qev.engine.snapshot().tick===priorityTest.beforeStep.tick && !priorityTest.records[2].appliedAt && qev.playMode==='inspection';
    `);
    await until(() => evaluate("!document.querySelector('#auto').disabled"));
    await evaluate("document.querySelector('#auto').click()");
    await until(() => evaluate("priorityTest.calls.length===4 && qev.agent.busy && !qev.engine.snapshot().paused"));
    await evaluate("priorityTest.records.push(qev.agent.current)");
    await up('explore');
    await evaluate("priorityTest.stopped=qev.engine.snapshot();priorityTest.answer(3)");
    await until(() => evaluate("!qev.agent.busy"));
    await check("reordering during Auto releases control and rejects the late old-priority reply without resuming", `
      await new Promise(resolve=>setTimeout(resolve,200));
      return priorityTest.records[3].status==='discarded' && !priorityTest.records[3].appliedAt &&
        qev.engine.snapshot().paused && qev.engine.snapshot().tick===priorityTest.stopped.tick &&
        qev.engine.snapshot().actionTicksLeft===0 && qev.playMode==='inspection' &&
        document.querySelector('#auto').getAttribute('aria-pressed')==='false';
    `);
    await choose('speed', '0.1');
    await until(() => evaluate("!document.querySelector('#step').disabled"));
    await evaluate("document.querySelector('#step').click();priorityTest.records.push(qev.agent.current);priorityTest.answer(4)");
    await until(() => evaluate("qev.agent.executing && qev.engine.snapshot().remaining>0"));
    await up('explore');
    await until(() => evaluate("!qev.agent.busy"));
    await check("a priority edit also interrupts an executing bounded Step", `
      const record=priorityTest.records[4];
      return record.status==='interrupted' && record.after.tick-record.before.tick<12 && qev.engine.snapshot().paused &&
        qev.engine.snapshot().remaining===0 && qev.playMode==='inspection';
    `);
    await evaluate("priorityTest.savedOrder=[...qev.priorityOrder];priorityTest.epoch=qev.engine.snapshot().epoch");
    await choose('difficulty', '0');
    await until(() => evaluate("qev.engine.snapshot().ready && qev.engine.snapshot().epoch!==priorityTest.epoch && !document.querySelector('#difficulty').disabled"));
    await check("map/difficulty reloads retain the user's priority order", `
      return qev.priorityOrder.join(',')===priorityTest.savedOrder.join(',') && qev.engine.snapshot().paused &&
        [...document.querySelectorAll('#priorities .priority-item')].map(row=>row.dataset.priority).join(',')===qev.priorityOrder.join(',');
    `);
    await evaluate(`(() => {
      const create=URL.createObjectURL, click=HTMLAnchorElement.prototype.click;
      URL.createObjectURL=function(blob){priorityTest.exported=blob.text().then(JSON.parse);return create.call(this,blob);};
      HTMLAnchorElement.prototype.click=function(){};
      try {document.querySelector('#export').click();}
      finally {URL.createObjectURL=create;HTMLAnchorElement.prototype.click=click;}
    })()`);
    await check("version-5 traces distinguish the active priority order from each decision's original order", `
      const trace=await priorityTest.exported, {objectivesFor}=await import('/src/objective.js');
      return trace.version===5 && JSON.stringify(trace.priorityOrder)===JSON.stringify(qev.priorityOrder) &&
        JSON.stringify(trace.objectives)===JSON.stringify(objectivesFor(qev.priorityOrder)) &&
        trace.records[0].priorityOrder[0]==='explore' && trace.records[0].requests[0].state===priorityTest.originalState &&
        trace.records.every(record=>record.priorityOrder.length===4 && record.objectives.length===4);
    `);
  } finally {
    await evaluate(`qev.pause();qev.agent.invalidate();qev.agent.getModel=priorityTest.getModel;
      for(const job of priorityTest.calls)job.resolve([])`);
  }
  await until(() => evaluate("!qev.agent.busy"));
  await evaluate("document.querySelector('#reset-priorities').click();qev.agent.history.length=0;qev.agent.invalidate()");
  await choose('speed', '1'); await choose('difficulty', '2');
  await until(() => evaluate("qev.engine.snapshot().ready && qev.engine.snapshot().difficulty===2 && !document.querySelector('#difficulty').disabled"));
  await evaluate("qev.pause();document.activeElement.blur();window.scrollTo(0,0);delete window.priorityTest");
}
