// ============================================================
// input-manager.ts — Global keyboard/mouse input manager
// ============================================================
//
// v2.12: Centralized input handling to fix sticky keys, scroll conflicts,
// and layout-independent hotkeys.
//
// Design principles (per Gemini consultation):
//   1. All modifier state tracked globally on window level
//   2. event.code (physical key) not event.key (logical character)
//   3. window.blur resets ALL keys (prevents sticky keys)
//   4. Wheel listeners use { passive: false } for preventDefault
//   5. Single source of truth for "what keys are held right now"
//
// Usage:
//   const input = getInputManager();
//   input.isKeyHeld('KeyZ')     // → true if Z is currently held
//   input.isModifierHeld('ctrl') // → true if Ctrl/Cmd is held
//   input.getChord()            // → "ctrl+shift+KeyZ" etc.
//   input.onKeyDown(callback)   // → subscribe to keydown events
//   input.onWheel(callback)     // → subscribe to wheel events (passive:false)
// ============================================================

type KeyCallback = (e: KeyboardEvent) => void;
type WheelCallback = (e: WheelEvent) => void;

class InputManager {
  private keys = new Set<string>();        // event.code values currently held
  private element: HTMLElement | Window;

  constructor(target: HTMLElement | Window = window) {
    this.element = target;
    this.attach();
  }

  private attach() {
    // Keydown: add to held set
    this.element.addEventListener('keydown', (e: Event) => {
      const ke = e as KeyboardEvent;
      this.keys.add(ke.code);
    }, { capture: true });

    // Keyup: remove from held set
    this.element.addEventListener('keyup', (e: Event) => {
      const ke = e as KeyboardEvent;
      this.keys.delete(ke.code);
    }, { capture: true });

    // Window blur: clear ALL keys (prevents sticky keys when alt-tabbing)
    window.addEventListener('blur', () => {
      this.keys.clear();
    });

    // Context menu (right-click): clear all keys (browser may eat keyup)
    window.addEventListener('contextmenu', () => {
      // Don't clear immediately — let the context menu handler run first.
      // Clear on next tick.
      setTimeout(() => this.keys.clear(), 0);
    });
  }

  /** Check if a physical key is currently held (by event.code, e.g. 'KeyZ', 'KeyB'). */
  isKeyHeld(code: string): boolean {
    return this.keys.has(code);
  }

  /** Check if Ctrl or Cmd is held (cross-platform). */
  isModifierHeld(mod: 'ctrl' | 'shift' | 'alt' | 'meta'): boolean {
    switch (mod) {
      case 'ctrl':  return this.keys.has('ControlLeft') || this.keys.has('ControlRight') || this.keys.has('MetaLeft') || this.keys.has('MetaRight');
      case 'shift': return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
      case 'alt':   return this.keys.has('AltLeft') || this.keys.has('AltRight');
      case 'meta':  return this.keys.has('MetaLeft') || this.keys.has('MetaRight');
    }
    return false;
  }

  /** Get current chord string, e.g. "ctrl+shift+KeyZ". Empty string if no keys. */
  getChord(): string {
    const parts: string[] = [];
    if (this.isModifierHeld('ctrl'))  parts.push('ctrl');
    if (this.isModifierHeld('shift')) parts.push('shift');
    if (this.isModifierHeld('alt'))   parts.push('alt');
    // Add non-modifier keys
    for (const code of this.keys) {
      if (!code.startsWith('Control') && !code.startsWith('Shift') &&
          !code.startsWith('Alt') && !code.startsWith('Meta')) {
        parts.push(code);
      }
    }
    return parts.join('+');
  }

  /** Clear all held keys. Call when focus is lost. */
  clearAll() {
    this.keys.clear();
  }

  /** Subscribe to keydown events. Returns unsubscribe function. */
  onKeyDown(callback: KeyCallback): () => void {
    const handler = (e: Event) => callback(e as KeyboardEvent);
    this.element.addEventListener('keydown', handler);
    return () => this.element.removeEventListener('keydown', handler);
  }

  /** Subscribe to keyup events. Returns unsubscribe function. */
  onKeyUp(callback: KeyCallback): () => void {
    const handler = (e: Event) => callback(e as KeyboardEvent);
    this.element.addEventListener('keyup', handler);
    return () => this.element.removeEventListener('keyup', handler);
  }

  /**
   * Subscribe to wheel events with passive:false (allows preventDefault).
   * CRITICAL: React's onWheel is passive by default in some browsers,
   * which means preventDefault() is ignored. This method uses a native
   * addEventListener with { passive: false } so we can stop browser zoom.
   */
  onWheel(target: HTMLElement, callback: WheelCallback): () => void {
    const handler = (e: Event) => callback(e as WheelEvent);
    target.addEventListener('wheel', handler, { passive: false });
    return () => target.removeEventListener('wheel', handler);
  }
}

// Singleton
let _instance: InputManager | null = null;

export function getInputManager(): InputManager {
  if (!_instance) {
    _instance = new InputManager();
  }
  return _instance;
}
