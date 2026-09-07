// Prepared call layout. The production entry remains disconnected until avatar QA.
export class CallView {
  constructor(surface) {
    this.surface = surface;
    this.opened = false;
    this.native = false;
    this.primary = 'dad';
    this.frames = ['dad', 'child'].map(name => [name, surface.querySelector(`.${name}-video .video-frame`)]);
    this.tools = document.createElement('div');
    this.tools.className = 'call-view-tools';
    this.tools.hidden = true;
    this.swapButton = this.button('互换画面', () => this.swap());
    this.returnButton = this.button('返回', () => this.close());
    this.tools.append(this.swapButton, this.returnButton);
    surface.append(this.tools);
    this.onKey = event => {
      if (!this.opened) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); }
      if (event.key === 'Tab') {
        const items = [...surface.querySelectorAll('button:not([disabled]), [tabindex="0"]')]
          .filter(item => item.getClientRects().length && !item.hidden);
        const index = items.indexOf(document.activeElement);
        if (items.length && (event.shiftKey ? index <= 0 : index === items.length - 1 || index < 0)) {
          event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0].focus();
        }
      }
    };
    this.onFullscreen = () => {
      if (document.fullscreenElement === surface) this.native = true;
      else if (this.opened && this.native) this.close();
    };
    document.addEventListener('keydown', this.onKey, true);
    document.addEventListener('fullscreenchange', this.onFullscreen);
    this.frameHandlers = this.frames.map(([name, frame]) => {
      const handler = event => {
        if (!this.opened || name === this.primary) return;
        if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
        event.preventDefault(); this.swap(); this.swapButton.focus();
      };
      frame.addEventListener('click', handler);
      frame.addEventListener('keydown', handler);
      return [frame, handler];
    });
  }
  button(label, callback) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = label;
    button.addEventListener('click', callback);
    return button;
  }
  open() {
    if (this.opened) return;
    this.opened = true; this.native = false;
    this.focusBefore = document.activeElement;
    this.savedFrames = this.frames.map(([, frame]) => [frame, ['role', 'tabindex', 'aria-label'].map(key => [key, frame.getAttribute(key)])]);
    this.inertBefore = [];
    for (let node = this.surface; node.parentElement && node !== document.body; node = node.parentElement) {
      for (const sibling of node.parentElement.children) if (sibling !== node) {
        this.inertBefore.push([sibling, sibling.inert]); sibling.inert = true;
      }
    }
    this.overflowBefore = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    this.surface.classList.add('call-view'); this.tools.hidden = false;
    this.render(); this.returnButton.focus();
    try {
      const pending = this.surface.requestFullscreen?.();
      Promise.resolve(pending).then(() => {
        if (!this.opened && document.fullscreenElement === this.surface) document.exitFullscreen?.().catch(() => {});
      }).catch(() => {}); // Viewport mode works when native fullscreen is unavailable.
    } catch (_) { /* Keep the same viewport layout. */ }
  }
  swap() {
    if (!this.opened) return;
    this.primary = this.primary === 'dad' ? 'child' : 'dad';
    this.render();
  }
  render() {
    this.surface.dataset.callPrimary = this.primary;
    this.swapButton.setAttribute('aria-label', this.primary === 'dad' ? '把我的画面放大' : '把爸爸老师的画面放大');
    for (const [name, frame] of this.frames) {
      frame.setAttribute('role', name === this.primary ? 'group' : 'button');
      frame.tabIndex = name === this.primary ? -1 : 0;
      frame.setAttribute('aria-label', name === this.primary ? (name === 'dad' ? '爸爸老师主画面' : '我的主画面') : (name === 'dad' ? '点一下放大爸爸老师' : '点一下放大我的画面'));
    }
  }
  close() {
    if (!this.opened) return;
    this.opened = false;
    this.surface.classList.remove('call-view'); delete this.surface.dataset.callPrimary;
    this.tools.hidden = true;
    document.body.style.overflow = this.overflowBefore;
    for (const [element, value] of this.inertBefore) element.inert = value;
    for (const [frame, attrs] of this.savedFrames) for (const [key, value] of attrs) {
      if (value === null) frame.removeAttribute(key); else frame.setAttribute(key, value);
    }
    if (document.fullscreenElement === this.surface) document.exitFullscreen?.().catch(() => {});
    if (this.focusBefore?.isConnected) this.focusBefore.focus();
  }
  destroy() {
    this.close(); this.tools.remove();
    document.removeEventListener('keydown', this.onKey, true);
    document.removeEventListener('fullscreenchange', this.onFullscreen);
    for (const [frame, handler] of this.frameHandlers) {
      frame.removeEventListener('click', handler); frame.removeEventListener('keydown', handler);
    }
  }
}
