// Globals available inside AudioWorkletGlobalScope.
declare const sampleRate: number;
declare const currentFrame: number;
declare const currentTime: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
