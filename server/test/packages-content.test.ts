import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPackageContentOrNull } from '../src/packages/service.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'routx-packages-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('чтение файлов зеркала', () => {
  it('возвращает содержимое, если файл на месте', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'packages'), { recursive: true });
    await writeFile(join(dir, 'packages', 'a.txt'), 'hello');

    const content = await readPackageContentOrNull(dir, {
      storage_path: 'packages/a.txt',
    } as never);

    expect(content?.toString('utf8')).toBe('hello');
  });

  it('возвращает null вместо ENOENT после переноса без тома данных', async () => {
    const dir = await tempDir();

    const content = await readPackageContentOrNull(dir, {
      storage_path: 'packages/missing.apk',
    } as never);

    expect(content).toBeNull();
  });
});
