// Keyboard + gamepad input with analog smoothing for keys.
const KEYMAP = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'handbrake',
  ShiftLeft: 'boost', ShiftRight: 'boost',
  Enter: 'start',
  KeyR: 'respawn',
  KeyC: 'camera',
  KeyM: 'mute',
};

export class InputManager {
  constructor() {
    this.keys = Object.create(null);   // held state by action name
    this._edges = Object.create(null); // pressed-this-frame
    this.actions = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false };
    this._steerSmooth = 0;
    this.anyKeyTime = 0; // last user-gesture timestamp (for audio unlock)

    window.addEventListener('keydown', (e) => {
      const a = KEYMAP[e.code];
      if (!a) return;
      if (a !== 'mute') e.preventDefault();
      if (!this.keys[a]) this._edges[a] = true;
      this.keys[a] = true;
      this.anyKeyTime = performance.now();
    });
    window.addEventListener('keyup', (e) => {
      const a = KEYMAP[e.code];
      if (a) this.keys[a] = false;
    });
    window.addEventListener('blur', () => {
      this.keys = Object.create(null);
    });
  }

  pressed(action) {
    if (this._edges[action]) {
      this._edges[action] = false;
      return true;
    }
    return false;
  }

  update(dt) {
    let up = this.keys.up ? 1 : 0;
    let down = this.keys.down ? 1 : 0;
    let steerTarget = (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0);
    let handbrake = !!this.keys.handbrake;
    let boost = !!this.keys.boost;

    // Gamepad overrides when active
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const rt = p.buttons[7]?.value ?? 0;
      const lt = p.buttons[6]?.value ?? 0;
      const sx = Math.abs(p.axes[0]) > 0.08 ? p.axes[0] : 0;
      if (rt > 0.02) up = rt;
      if (lt > 0.02) down = lt;
      if (sx !== 0) steerTarget = sx;
      if (p.buttons[0]?.pressed) handbrake = true; // A
      if (p.buttons[2]?.pressed || p.buttons[5]?.pressed) boost = true; // X or RB
      if (p.buttons[9]?.pressed && !this._padStart) this._edges.start = true;
      this._padStart = p.buttons[9]?.pressed;
      if (p.buttons[3]?.pressed && !this._padY) this._edges.respawn = true;
      this._padY = p.buttons[3]?.pressed;
      break;
    }

    // Keyboard steering feels analog: fast attack, faster centering.
    const rate = steerTarget !== 0 ? 6.5 : 9.5;
    this._steerSmooth += (steerTarget - this._steerSmooth) * Math.min(1, rate * dt);
    if (Math.abs(this._steerSmooth) < 0.001 && steerTarget === 0) this._steerSmooth = 0;

    this.actions.throttle = up;
    this.actions.brake = down;
    this.actions.steer = this._steerSmooth;
    this.actions.handbrake = handbrake;
    this.actions.boost = boost;

    // QA/automation hook: harness-injected actions override raw input.
    if (typeof window !== 'undefined' && window.__APEX_QA__) {
      Object.assign(this.actions, window.__APEX_QA__);
    }
  }
}
