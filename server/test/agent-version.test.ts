import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bundledAgentVersion } from '../src/agent/version.js';

const previous = process.env.RC_AGENT_DIST;
const dirs: string[] = [];

afterEach(async () => {
  if (previous === undefined) delete process.env.RC_AGENT_DIST;
  else process.env.RC_AGENT_DIST = previous;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('версия агента из образа', () => {
  it('читает routx-agent.version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'routx-agent-'));
    dirs.push(dir);
    await writeFile(join(dir, 'routx-agent.version'), '1.5.52\n');
    process.env.RC_AGENT_DIST = dir;

    expect(bundledAgentVersion()).toBe('1.5.52');
  });

  it('возвращает null без файла версии', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'routx-agent-'));
    dirs.push(dir);
    process.env.RC_AGENT_DIST = dir;

    expect(bundledAgentVersion()).toBeNull();
  });
});
