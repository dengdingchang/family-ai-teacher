// One real avatar frame follows the child between activities. No second player,
// camera capture, frame copy, or connection is created.
export class AvatarCompanion {
  constructor(stage) {
    this.stage = stage;
    this.frame = stage.querySelector('.dad-video .video-frame');
    this.anchor = document.createComment('avatar home');
    this.frame.before(this.anchor);
    this.panel = document.createElement('aside');
    this.panel.className = 'avatar-companion';
    this.panel.setAttribute('aria-label', '爸爸老师视频小窗');
    this.panel.hidden = true;
    this.move = this.button('爸爸陪着你', '拖动爸爸小窗，方向键移动', () => {});
    this.move.className = 'avatar-companion__move';
    this.body = document.createElement('div'); this.body.className = 'avatar-companion__body';
    this.tools = document.createElement('div'); this.tools.className = 'avatar-companion__tools';
    this.tools.append(this.button('−', '缩小爸爸画面', () => this.resize(-32)),
      this.button('+', '放大爸爸画面', () => this.resize(32)));
    this.resizeHandle = this.button('↘', '拖动调整爸爸画面大小', () => {});
    this.tools.append(this.resizeHandle);
    this.panel.append(this.move, this.body, this.tools);
    this.width = innerWidth <= 640 ? 148 : 220;
    this.position = null; this.host = null;
    this.onPointer = (event, resizing) => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      const start = {x:event.clientX,y:event.clientY,width:this.width,...this.position};
      const move = e => {
        e.preventDefault(); e.stopPropagation();
        if (resizing) this.width = start.width + e.clientX - start.x;
        else this.position = {left:start.left + e.clientX-start.x, top:start.top+e.clientY-start.y};
        this.place();
      };
      const end = e => {
        e.stopPropagation(); target.removeEventListener('pointermove',move);
        target.removeEventListener('pointerup',end); target.removeEventListener('pointercancel',end);
        if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      };
      target.addEventListener('pointermove',move); target.addEventListener('pointerup',end); target.addEventListener('pointercancel',end);
    };
    this.move.addEventListener('pointerdown',e=>this.onPointer(e,false));
    this.resizeHandle.addEventListener('pointerdown',e=>this.onPointer(e,true));
    this.move.addEventListener('keydown',e=>{
      const delta = {ArrowLeft:[-20,0],ArrowRight:[20,0],ArrowUp:[0,-20],ArrowDown:[0,20]}[e.key];
      if (!delta) return; e.preventDefault(); e.stopPropagation();
      this.position.left += delta[0]; this.position.top += delta[1]; this.place();
    });
    this.refresh = () => this.sync();
    this.observer = new MutationObserver(this.refresh);
    this.observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','data-state']});
    this.levelObserver = new MutationObserver(() => {
      this.panel.style.setProperty('--listening-level', this.stage.style.getPropertyValue('--listening-level') || '0');
    });
    this.levelObserver.observe(stage,{attributes:true,attributeFilter:['style']});
    window.addEventListener('resize',this.refresh);
    document.addEventListener('fullscreenchange',this.refresh);
    this.sync();
  }
  button(text,label,action) {
    const b=document.createElement('button'); b.type='button'; b.textContent=text;
    b.setAttribute('aria-label',label); b.title=label;
    b.addEventListener('click',e=>{e.stopPropagation();action();}); return b;
  }
  activeHost() {
    const layers=[...document.querySelectorAll('.drawing-board,.chess-board,.music-studio,.media-viewer')]
      .filter(e=>!e.hidden && e.getClientRects().length);
    layers.sort((a,b)=>(parseInt(getComputedStyle(a).zIndex)||0)-(parseInt(getComputedStyle(b).zIndex)||0));
    return layers.at(-1) || null;
  }
  sync() {
    const host = this.activeHost();
    const state = this.stage.dataset.state || 'idle';
    if (this.panel.dataset.state !== state) this.panel.dataset.state = state;
    if (host !== this.host) {
      const idle = this.frame.querySelector('video');
      const resumeIdle = Boolean(idle && !idle.hidden && (!idle.paused || this.resumeIdleAfterMove));
      this.resumeIdleAfterMove = resumeIdle;
      this.host?.classList.remove('has-avatar-companion');
      this.host=host;
      if (host) {
        host.classList.add('has-avatar-companion');
        this.body.append(this.frame); host.append(this.panel); this.panel.hidden=false;
        if (host.matches('.chess-board,.music-studio')) {
          this.width = 148;
          this.position = {left:innerWidth-this.width-16,top:12};
        }
        if (!this.position) this.position={left:innerWidth-this.width-16,top:innerWidth<=640?12:100};
      } else {
        this.anchor.after(this.frame); this.panel.hidden=true; this.panel.remove();
      }
      if (resumeIdle) idle.play().catch(()=>{});
    }
    if (host) this.place();
  }
  resize(delta) { this.width += delta; this.place(); }
  place() {
    this.width=Math.min(Math.max(148,this.width),Math.min(480,innerWidth-24));
    if (innerWidth >= 900 && this.host?.matches('.chess-board,.music-studio')) this.width=Math.min(this.width,Math.min(280,innerWidth*.22));
    const height=this.width*0.75+100;
    this.position.left=Math.max(8,Math.min(this.position.left,innerWidth-this.width-8));
    this.position.top=Math.max(8,Math.min(this.position.top,innerHeight-height-8));
    if (this.host?.matches('.chess-board,.music-studio')) {
      this.host.style.setProperty('--companion-safe-height', `${height + 24}px`);
      this.host.style.setProperty('--companion-safe-width', `${this.width + 32}px`);
      // Keep dragging/resizing, but don't let Dad cover a board, piano key or action.
      const overlaps = [...this.host.querySelectorAll('button,.chess-board__grid,.music-studio__rhythm')]
        .filter(node => !this.panel.contains(node) && node.getClientRects().length)
        .some(node => {
          const r = node.getBoundingClientRect();
          return this.position.left < r.right && this.position.left + this.width > r.left
            && this.position.top < r.bottom && this.position.top + height > r.top;
        });
      if (overlaps) this.position={left:innerWidth-this.width-16,top:12};
    }
    Object.assign(this.panel.style,{width:`${this.width}px`,left:`${this.position.left}px`,top:`${this.position.top}px`});
  }
  destroy() {
    this.observer.disconnect(); this.levelObserver.disconnect(); window.removeEventListener('resize',this.refresh);
    document.removeEventListener('fullscreenchange',this.refresh);
    this.host?.classList.remove('has-avatar-companion');
    this.anchor.after(this.frame); this.anchor.remove(); this.panel.remove();
  }
}
