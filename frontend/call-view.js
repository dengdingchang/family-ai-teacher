// The child home keeps the existing media elements in place and only changes
// their visual roles. It never asks for media or takes over the page.
export class CallView {
  constructor(surface) {
    this.surface = surface;
    this.primary = 'dad';
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
    this.primary = this.primary === 'dad' ? 'child' : 'dad';
    this.render();
  }

  render() {
    this.surface.dataset.callPrimary = this.primary;
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
    this.primary = 'dad';
    this.render();
  }

  destroy() {
    this.surface.classList.remove('call-view');
    delete this.surface.dataset.callPrimary;
    for (const [frame, handler] of this.frameHandlers) {
      frame.removeEventListener('click', handler);
      frame.removeEventListener('keydown', handler);
    }
  }
}
