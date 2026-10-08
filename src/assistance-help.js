/** Hover/focus is a non-modal preview; click/tap/Enter pins the same copy in a
 * native modal dialog. Hover never steals focus or interrupts the experiment. */
export function helpPlacement(anchor, size, viewport) {
  const edge = 8, gap = 6;
  const below = Math.max(0, viewport.height - anchor.bottom - gap - edge);
  const above = Math.max(0, anchor.top - gap - edge);
  const down = size.height <= below || below >= above;
  const maxHeight = Math.max(1, down ? below : above);
  return {
    left: Math.max(edge, Math.min(anchor.left, viewport.width - size.width - edge)),
    top: down ? anchor.bottom + gap : Math.max(edge, anchor.top - gap - Math.min(size.height, maxHeight)),
    maxHeight,
  };
}

export class AssistanceHelp {
  constructor({ button, preview, dialog, onOpen = () => {} }) {
    Object.assign(this, { button, preview, dialog, onOpen });
    this.document = button.ownerDocument;
    this.view = this.document.defaultView;
    this.buttonHovered = this.previewHovered = this.anchorHovered = this.suppressed = false;
    this.anchor = button.closest('.assistance-setting') || button;
    this.timer = null;
    // One authored explanation; no duplicated IDs or divergent On/Off descriptions.
    const copy = dialog.querySelector('.help-copy').cloneNode(true);
    for (const node of copy.querySelectorAll('[id]')) node.removeAttribute('id');
    preview.querySelector('.help-copy').replaceChildren(...copy.childNodes);
    button.addEventListener('pointerenter', event => {
      if (event.pointerType !== 'mouse') return;
      this.buttonHovered = true; this.showPreview();
    });
    button.addEventListener('pointerleave', () => { this.buttonHovered = false; this.scheduleHide(); });
    button.addEventListener('focus', () => this.showPreview());
    button.addEventListener('blur', () => this.scheduleHide());
    button.addEventListener('click', () => this.openDialog());
    // Keep the preview reachable across the field, without covering its dropdown.
    this.anchor.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') { this.anchorHovered = true; this.clearTimer(); } });
    this.anchor.addEventListener('pointerleave', () => { this.anchorHovered = false; this.scheduleHide(); });
    preview.addEventListener('pointerenter', () => { this.previewHovered = true; this.clearTimer(); });
    preview.addEventListener('pointerleave', () => { this.previewHovered = false; this.scheduleHide(); });
    preview.addEventListener('focusin', () => this.clearTimer());
    preview.addEventListener('focusout', () => this.scheduleHide());
    preview.querySelector('[data-help-open]').addEventListener('click', () => this.openDialog());
    preview.querySelector('[data-help-close]').addEventListener('click', () => this.dismissPreview());
    for (const close of dialog.querySelectorAll('[data-help-close]')) close.addEventListener('click', () => this.closeDialog());
    dialog.addEventListener('cancel', event => { event.preventDefault(); this.closeDialog(); });
    dialog.addEventListener('close', () => this.finishClose());
    let backdropDown = false;
    const outside = event => {
      const r = dialog.getBoundingClientRect();
      return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
    };
    dialog.addEventListener('pointerdown', event => { backdropDown = event.target === dialog && outside(event); });
    dialog.addEventListener('click', event => {
      if (backdropDown && event.target === dialog && outside(event)) this.closeDialog();
      backdropDown = false;
    });
    this.document.addEventListener('pointerdown', event => {
      if (!preview.hidden && !button.contains(event.target) && !preview.contains(event.target)) this.dismissPreview(false);
    }, true);
    this.view.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || (!dialog.open && preview.hidden)) return;
      // Consume this Escape rather than forwarding it to the game's Stop shortcut.
      event.preventDefault(); event.stopImmediatePropagation();
      if (dialog.open) this.closeDialog(); else this.dismissPreview();
    }, true);
    this.view.addEventListener('resize', () => this.position());
    this.view.addEventListener('scroll', event => {
      if (event.target === this.view || !preview.contains(event.target)) this.position();
    }, true);
    this.view.addEventListener('blur', () => this.dismissPreview(false));
    this.document.addEventListener('visibilitychange', () => { if (this.document.hidden) this.dismissPreview(false); });
  }
  get modalOpen() { return this.dialog.open; }
  clearTimer() { clearTimeout(this.timer); this.timer = null; }
  interested() {
    return this.buttonHovered || this.previewHovered || (!this.preview.hidden && this.anchorHovered) || this.document.activeElement === this.button ||
      this.preview.contains(this.document.activeElement);
  }
  showPreview() {
    this.clearTimer();
    if (this.dialog.open || this.suppressed) return;
    const opening = this.preview.hidden;
    this.preview.hidden = false;
    if (opening) this.preview.querySelector('.help-copy').scrollTop = 0;
    this.button.setAttribute('aria-expanded', 'true');
    this.position();
  }
  position() {
    if (this.preview.hidden) return;
    const viewport = { width: this.document.documentElement.clientWidth, height: this.view.innerHeight };
    this.preview.style.maxHeight = `${Math.max(1, viewport.height - 16)}px`;
    const field = this.anchor.getBoundingClientRect(), trigger = this.button.getBoundingClientRect();
    if (field.bottom <= 0 || field.top >= viewport.height || field.right <= 0 || field.left >= viewport.width) {
      this.dismissPreview(false); return;
    }
    const position = helpPlacement({ left: trigger.left, top: field.top, bottom: field.bottom }, this.preview.getBoundingClientRect(), viewport);
    this.preview.style.left = `${position.left}px`;
    this.preview.style.top = `${position.top}px`;
    this.preview.style.maxHeight = `${position.maxHeight}px`;
  }
  hidePreview() {
    this.clearTimer(); this.preview.hidden = true; this.previewHovered = false;
    this.button.setAttribute('aria-expanded', String(this.dialog.open));
  }
  dismissPreview(restoreFocus = true) {
    const hadFocus = this.preview.contains(this.document.activeElement);
    // Suppress only the current hover/focus, not a future visit after a background
    // blur or outside click. Otherwise an already-hidden preview could get stuck.
    this.suppressed = !this.preview.hidden && this.interested();
    this.hidePreview();
    if (restoreFocus && hadFocus) this.button.focus({ preventScroll: true });
  }
  scheduleHide() {
    this.clearTimer();
    if (this.dialog.open || this.interested()) return;
    this.suppressed = false;
    // A small bridge across the gap makes the preview hoverable and scrollable.
    this.timer = setTimeout(() => { if (!this.interested()) this.hidePreview(); }, 180);
  }
  openDialog() {
    if (this.dialog.open) return;
    this.suppressed = true; this.hidePreview();
    this.onOpen(); // Stop/cancel input only on deliberate opening, never on hover.
    this.dialog.showModal();
    this.dialog.querySelector('.help-copy').scrollTop = 0;
    this.document.body.classList.add('help-modal-open');
    this.button.setAttribute('aria-expanded', 'true');
    this.dialog.querySelector('[data-help-close]').focus({ preventScroll: true });
  }
  closeDialog() {
    if (!this.dialog.open) return;
    this.suppressed = true; // Returning focus must not immediately reopen the preview.
    this.dialog.close(); this.finishClose();
  }
  finishClose() {
    if (this.dialog.open) return; // Ignore an old queued close event after reopening.
    this.document.body.classList.remove('help-modal-open');
    this.button.setAttribute('aria-expanded', 'false');
    this.suppressed = true;
    this.button.focus({ preventScroll: true });
  }
}
