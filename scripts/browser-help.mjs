// Native hover/click/keyboard/touch checks. The parent harness enforces --mute-audio.
export async function checkHelp({ evaluate, check, call, until, onScreenshot = async () => {} }) {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const point = async selector => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const move = async selector => call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await point(selector) });
  const away = () => call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3 });
  const click = async selector => {
    const p = await point(selector);
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...p });
  };
  const key = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers, ...(key === 'Enter' ? { text: '\r' } : key === ' ' ? { text: ' ' } : {}) });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers });
  };
  await check('assistance has a circled, separately labelled help button even before game/model loading', `
    const b=document.querySelector('#assistance-help-button'), select=document.querySelector('#assistance');
    const r=b.getBoundingClientRect(), circle=b.querySelector('span');
    return !b.disabled && b.type==='button' && b.getAttribute('aria-haspopup')==='dialog' &&
      b.getAttribute('aria-label')==='What is assistance?' && b.getAttribute('aria-expanded')==='false' &&
      !b.closest('label') && select.labels.length===1 && select.labels[0].textContent==='Assistance' &&
      r.width>=24 && r.height>=24 && circle.textContent==='?' && getComputedStyle(circle).borderRadius==='50%' &&
      document.querySelector('#reset').disabled && !qev.engine && !qev.model;
  `);
  await evaluate("document.querySelector('#backend').focus();window.helpFocus=document.activeElement");
  await move('#assistance-help-button');
  await until(() => evaluate("!document.querySelector('#assistance-help-preview').hidden"));
  await check('hover opens the explanation without stealing focus, changing assistance, or loading a model', `
    const p=document.querySelector('#assistance-help-preview'), d=document.querySelector('#assistance-help');
    const r=p.getBoundingClientRect(), field=document.querySelector('.assistance-setting').getBoundingClientRect();
    return (r.top>=field.bottom+5 || r.bottom<=field.top-5) && !p.hidden && !d.open && document.activeElement===helpFocus && !qev.engine && !qev.model &&
      document.querySelector('#assistance').value==='assisted' && document.querySelector('#assistance-help-button').getAttribute('aria-expanded')==='true' &&
      p.querySelector('.help-copy').textContent===d.querySelector('.help-copy').textContent &&
      p.textContent.includes('Assistance is OK here.') && p.textContent.includes('not its ability to execute') &&
      r.left>=8 && r.right<=innerWidth-8 && r.top>=8 && r.bottom<=innerHeight-8;
  `);
  await move('#assistance'); await wait(250);
  await check('the preview remains reachable across the assistance field without covering its dropdown', `return !document.querySelector('#assistance-help-preview').hidden;`);
  await move('#assistance-help-preview .help-copy'); await wait(250);
  await check('the hover panel stays open while the pointer is over its content', `return !document.querySelector('#assistance-help-preview').hidden;`);
  await onScreenshot('preview');
  await key('Escape', 'Escape', 27);
  await check('Escape dismisses the preview without moving focus or opening a modal', `
    return document.querySelector('#assistance-help-preview').hidden && !document.querySelector('#assistance-help').open && document.activeElement===helpFocus;
  `);
  await away(); await wait(250);
  await move('#assistance-help-button');
  await until(() => evaluate("!document.querySelector('#assistance-help-preview').hidden"));
  await away(); await wait(250);
  await check('leaving both the trigger and preview closes the transient popup', `return document.querySelector('#assistance-help-preview').hidden;`);
  await evaluate("dispatchEvent(new Event('blur'))");
  await move('#assistance-help-button');
  await check('a background blur while help is closed cannot disable future hover previews', `return !document.querySelector('#assistance-help-preview').hidden;`);
  await click('.brand h1');
  await move('#assistance-help-button');
  await check('outside-click dismissal also permits a later hover', `return !document.querySelector('#assistance-help-preview').hidden;`);
  await click('#assistance-help-button');
  await check('click pins the explanation in a real native modal with accessible focus and no duplicate IDs', `
    const d=document.querySelector('#assistance-help'), ids=[...document.querySelectorAll('[id]')].map(e=>e.id);
    return d.open && d.matches(':modal') && d.contains(document.activeElement) && document.querySelector('#assistance-help-preview').hidden &&
      document.body.classList.contains('help-modal-open') && ids.length===new Set(ids).size &&
      d.textContent.includes('Compare runs with the same setting') && d.textContent.includes('not RGB-only vision');
  `);
  await check('modal background controls cannot take focus', `
    document.querySelector('#backend').focus();return document.querySelector('#assistance-help').contains(document.activeElement);
  `);
  await onScreenshot('desktop');
  await key('Tab', 'Tab', 9, 8);
  await check('keyboard navigation remains inside the modal', `return document.querySelector('#assistance-help').contains(document.activeElement);`);
  await key('Escape', 'Escape', 27);
  await check('closing returns focus to the help button without reopening its hover preview', `
    return !document.querySelector('#assistance-help').open && document.querySelector('#assistance-help-preview').hidden &&
      !document.body.classList.contains('help-modal-open') && document.activeElement===document.querySelector('#assistance-help-button') &&
      document.activeElement.getAttribute('aria-expanded')==='false';
  `);
  await key('Enter', 'Enter', 13);
  await check('Enter opens the same explanation from the help button', `return document.querySelector('#assistance-help').matches(':modal');`);
  await click('#assistance-help .help-foot [data-help-close]');
  await check('the explicit Close button dismisses the modal', `return !document.querySelector('#assistance-help').open;`);
  await key(' ', 'Space', 32);
  await check('Space also activates the native help button', `return document.querySelector('#assistance-help').matches(':modal');`);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: 4, y: 4 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: 4, y: 4 });
  await check('a backdrop click dismisses the modal without activating the page behind it', `
    return !document.querySelector('#assistance-help').open && document.activeElement===document.querySelector('#assistance-help-button') && !qev.model;
  `);
  try {
    await call('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 1, mobile: true });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true });
    await wait(100);
    const p = await point('#assistance-help-button');
    await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...p, radiusX: 1, radiusY: 1 }] });
    await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await until(() => evaluate("document.querySelector('#assistance-help').open"));
    await check('a touch tap opens a viewport-bounded mobile modal with a scrollable body and visible Close controls', `
      const d=document.querySelector('#assistance-help'), r=d.getBoundingClientRect(), body=d.querySelector('.help-copy');
      const buttons=[...d.querySelectorAll('[data-help-close]')].map(e=>e.getBoundingClientRect());
      const target=Math.min(80,body.scrollHeight-body.clientHeight);body.scrollTop=target;await new Promise(resolve=>setTimeout(resolve,100));
      return d.matches(':modal') && r.left>=8 && r.right<=innerWidth-8 && r.top>=8 && r.bottom<=innerHeight-8 &&
        document.documentElement.scrollWidth<=innerWidth && target>0 && body.scrollTop>=target-1 &&
        buttons.every(r=>r.width>=32 && r.height>=32 && r.top>=0 && r.bottom<=innerHeight);
    `);
    await onScreenshot('mobile-scrolled');
    await click('#assistance-help .help-head [data-help-close]');
    await evaluate("document.querySelector('#assistance-help-button').click()");
    await check('reopening starts at the decision-focused explanation rather than retaining an old scroll position', `return document.querySelector('#assistance-help .help-copy').scrollTop===0;`);
    await onScreenshot('mobile');
    await click('#assistance-help .help-head [data-help-close]');
  } finally {
    await evaluate("document.querySelector('#assistance-help .help-head [data-help-close]').click();document.activeElement.blur();delete window.helpFocus;scrollTo(0,0)");
    await call('Emulation.setTouchEmulationEnabled', { enabled: false });
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await away(); await wait(250);
  }
}
