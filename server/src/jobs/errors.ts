export class JobFailure extends Error {
  readonly code: string;
  readonly terminal: 'failed' | 'timeout' | 'cancelled';

  constructor(code: string, message: string, terminal: 'failed' | 'timeout' | 'cancelled' = 'failed') {
    super(message);
    this.name = 'JobFailure';
    this.code = code;
    this.terminal = terminal;
  }
}
