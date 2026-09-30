// The child home keeps the existing media elements in place and only changes
// their visual roles. It never asks for media or takes over the page.
export class CallView {
  constructor(surface) {
    this.surface = surface;
    this.doc = surface.ownerDocument || globalThis.document;
    this.primary = 'dad';
    this.immersive = false;
    this.expandButton = surface.querySelector('#dadExpandButton');
    this._expandHandler = event => { event.preventDefault(); event.stopPropagation(); this.toggleImmersive(); };
    this._escapeHandler = event => {
      if (this.immersive && event.key === 'Escape') { event.preventDefault(); this.toggleImmersive(false); }
    };
    this.expandButton?.addEventListener('click', this._expandHandler);
    this.doc?.addEventListener?.('keydown', this._escapeHandler);
    this.frames = ['dad', 'child'].map(name => [name, surface.querySelector(`.${name}-video .video-frame`)]);
    this.frameHandlers = this.frames.map(([name, frame]) => {
      const handler = event => {
        if (frame.closest('.avatar-companion')) return;
        if (name === this.primary) return;
        if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        this.swap();
        frame.focus();
      };
      frame.addEventListener('click', handler);
      frame.addEventListener('keydown', handler);
      return [frame, handler];
    });
    this.surface.classList.add('call-view');
    this.render();
  }

  open() {
    this.surface.classList.add('call-view');
    this.render();
  }

  swap() {
    if (this.immersive) return;
    this.primary = this.primary === 'dad' ? 'child' : 'dad';
    this.render();
  }

  toggleImmersive(force = !this.immersive) {
    if (this.immersive === force) return;
    this.immersive = force;
    if (force) {
      this.primary = 'dad';
      this.overflowBefore = this.doc?.body?.style?.overflow;
      if (this.doc?.body?.style) this.doc.body.style.overflow = 'hidden';
    } else if (this.doc?.body?.style) this.doc.body.style.overflow = this.overflowBefore || '';
    this.surface.classList.toggle('is-dad-immersive', force);
    this.render();
    this.expandButton?.focus?.({ preventScroll: true });
  }

  render() {
    this.surface.dataset.callPrimary = this.primary;
    if (this.expandButton) {
      const label = this.immersive ? '收起爸爸老师画面' : '放大爸爸老师画面';
      this.expandButton.setAttribute('aria-label', label);
      this.expandButton.setAttribute('aria-pressed', String(this.immersive));
      this.expandButton.title = label;
      const text = this.expandButton.querySelector('.dad-expand-label');
      if (text) text.textContent = this.immersive ? '收起' : '放大';
    }
    for (const [name, frame] of this.frames) {
      frame.setAttribute('role', name === this.primary ? 'group' : 'button');
      frame.tabIndex = name === this.primary ? -1 : 0;
      frame.setAttribute('aria-label', name === this.primary
        ? (name === 'dad' ? '爸爸老师主画面' : '我的主画面')
        : (name === 'dad' ? '点一下放大爸爸老师' : '点一下放大我的画面'));
    }
  }

  // Kept for older callers; it restores the default dad-main composition.
  close() {
    this.toggleImmersive(false);
    this.primary = 'dad';
    this.render();
  }

  destroy() {
    this.toggleImmersive(false);
    this.surface.classList.remove('call-view');
    delete this.surface.dataset.callPrimary;
    this.expandButton?.removeEventListener('click', this._expandHandler);
    this.doc?.removeEventListener?.('keydown', this._escapeHandler);
    for (const [frame, handler] of this.frameHandlers) {
      frame.removeEventListener('click', handler);
      frame.removeEventListener('keydown', handler);
    }
  }
}
