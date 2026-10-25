/**
 * Playback over a timeline: a single time value `t` that the 3D scene reads every frame and the
 * panels read through `useSyncExternalStore`. Owns its own animation loop so the readouts keep
 * running even if WebGL is unavailable.
 */
import type { Timeline } from './sim/timeline.ts';

export const SPEEDS = [0.25, 0.5, 1, 2, 5, 10, 25, 50];

export class Player {
  timeline: Timeline | null = null;
  t = 0;
  playing = false;
  speed = 5;
  private version = 0;
  private listeners = new Set<() => void>();
  private frame = 0;
  private last = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getVersion = () => this.version;

  private emit() {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  load(timeline: Timeline | null) {
    this.pause();
    this.timeline = timeline;
    this.t = 0;
    this.emit();
  }

  play() {
    if (!this.timeline || this.playing) return;
    if (this.t >= this.timeline.duration) this.t = 0;
    this.playing = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.playing || !this.timeline) return;
      this.t = Math.min(this.timeline.duration, this.t + ((now - this.last) / 1000) * this.speed);
      this.last = now;
      if (this.t >= this.timeline.duration) this.playing = false;
      this.emit();
      if (this.playing) this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
    this.emit();
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.frame);
    this.emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(t: number) {
    if (!this.timeline) return;
    this.t = Math.min(Math.max(t, 0), this.timeline.duration);
    this.emit();
  }

  setSpeed(speed: number) {
    this.speed = speed;
    this.emit();
  }

  /** Pauses and jumps to the start of the next G-code line that moves the machine. */
  stepLine() {
    if (!this.timeline) return;
    this.pause();
    const line = this.timeline.stateAt(this.t).line;
    let next = this.timeline.duration;
    for (const [l, start] of this.timeline.lineStart) if (l > line && start > this.t + 1e-9 && start < next) next = start;
    this.seek(next);
  }
}
