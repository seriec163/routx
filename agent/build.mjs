import { mkdir, copyFile, writeFile, readFile, chmod, cp, rm, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const files = join(root, 'files');
const dist = join(root, 'dist');
const stage = join(dist, 'stage');

const version = (await readFile(join(root, 'VERSION'), 'utf8')).trim();

// Версия в пакете и в probe должны совпадать, иначе панель показывает
// старое значение и не предлагает обновление.
const clientSource = await readFile(join(files, 'usr/lib/routx-agent/jn_client.uc'), 'utf8');
if (!clientSource.includes(`const VERSION = "${version}";`)) {
  throw new Error(`agent/VERSION (${version}) не совпадает с jn_client.uc`);
}

await mkdir(dist, { recursive: true });

// Все файлы агента — текст. На Windows рабочие копии могут быть с CRLF:
// пакет с CRLF ломает shebang /bin/sh и init-скрипты. Собираем из staging
// с принудительно LF, чтобы пакет был одинаковым на любой ОС.
async function normalizeTextTree(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await normalizeTextTree(path);
      continue;
    }
    if (!entry.isFile()) continue;
    const data = await readFile(path);
    if (data.includes(0)) continue;
    const text = data.toString('utf8');
    if (text.includes('\r\n')) await writeFile(path, text.replace(/\r\n/g, '\n'));
  }
}

await rm(stage, { recursive: true, force: true });
await cp(files, stage, { recursive: true });
await normalizeTextTree(stage);

// Бит исполнения должен быть в архиве, независимо от файловой системы сборки.
for (const relative of [
  'etc/init.d/routx-agent',
  'etc/uci-defaults/90-routx-agent',
  'usr/bin/routx-agent',
  'usr/libexec/routx-agent-exec',
]) {
  await chmod(join(stage, relative), 0o755);
}

// tar.gz (primary for apk/fallback)
execSync(`tar -C "${stage}" -czf "${join(dist, 'routx-agent.tar.gz')}" .`, { stdio: 'inherit' });

// OpenWrt 24.10+ принимает ipk как gzip-tar с debian-binary + control.tar.gz + data.tar.gz.
try {
  const ipkdir = join(dist, 'ipk');
  const staging = join(ipkdir, 'staging');
  await mkdir(join(ipkdir, 'CONTROL'), { recursive: true });
  await mkdir(staging, { recursive: true });

  execSync(`tar -C "${stage}" -cf "${join(ipkdir, 'data.tar.gz')}" --gzip .`, { stdio: 'inherit' });

  // Жёсткие зависимости только на команды, без которых пакет не имеет смысла.
  // Модули ucode и timeout установщик проверяет и доустанавливает сам:
  // в минимальных прошивках часть пакетов отсутствует, и opkg тогда
  // отказывается ставить routx-agent целиком.
  const control = `Package: routx-agent\nVersion: ${version}-1\nDepends: ucode, curl\nSection: net\nArchitecture: all\nMaintainer: RoutX\nDescription: RoutX agent for OpenWrt\n`;
  await writeFile(join(ipkdir, 'CONTROL', 'control'), control);
  await writeFile(join(ipkdir, 'CONTROL', 'conffiles'), '/etc/config/routx\n');
  await writeFile(
    join(ipkdir, 'CONTROL', 'postinst'),
    [
      '#!/bin/sh',
      '[ -x /etc/uci-defaults/90-routx-agent ] && /etc/uci-defaults/90-routx-agent',
      '/etc/init.d/routx-agent enable 2>/dev/null',
      '# self_update останавливает старый агент перед установкой; поднимаем новый.',
      '/etc/init.d/routx-agent restart 2>/dev/null',
      '# opkg кладёт сюда свою копию conffile при каждом обновлении.',
      'rm -f /etc/config/routx-opkg',
      '# LuCI читает menu.d при загрузке, а ACL кэширует rpcd.',
      'rm -f /tmp/luci-indexcache* 2>/dev/null',
      '[ -x /etc/init.d/rpcd ] && /etc/init.d/rpcd reload 2>/dev/null',
      'exit 0',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(ipkdir, 'CONTROL', 'prerm'),
    '#!/bin/sh\n/etc/init.d/routx-agent stop 2>/dev/null\n/etc/init.d/routx-agent disable 2>/dev/null\nexit 0\n',
  );
  await chmod(join(ipkdir, 'CONTROL', 'postinst'), 0o755);
  await chmod(join(ipkdir, 'CONTROL', 'prerm'), 0o755);

  execSync(`tar -C "${join(ipkdir, 'CONTROL')}" -cf "${join(ipkdir, 'control.tar.gz')}" --gzip .`, {
    stdio: 'inherit',
  });
  await writeFile(join(staging, 'debian-binary'), '2.0\n');
  await copyFile(join(ipkdir, 'control.tar.gz'), join(staging, 'control.tar.gz'));
  await copyFile(join(ipkdir, 'data.tar.gz'), join(staging, 'data.tar.gz'));

  const target = join(dist, `routx-agent_${version}_all.ipk`);
  execSync(`tar -C "${staging}" -czf "${target}" ./debian-binary ./control.tar.gz ./data.tar.gz`, {
    stdio: 'inherit',
  });
  await copyFile(target, join(dist, 'routx-agent.ipk'));
} catch (error) {
  console.log('ipk build skipped:', error.message);
}

// OpenWrt 25+ uses apk-tools. Package data excludes /etc/config/routx:
// the config is created by 90-routx-agent and must survive agent upgrades.
try {
  const apkRoot = join(dist, 'apk-root');
  await rm(apkRoot, { recursive: true, force: true });
  await cp(stage, apkRoot, { recursive: true });
  await rm(join(apkRoot, 'etc/config/routx'), { force: true });

  const postInstall = join(dist, 'apk-post-install.sh');
  const preDeinstall = join(dist, 'apk-pre-deinstall.sh');
  await writeFile(
    postInstall,
    [
      '#!/bin/sh',
      '[ -x /etc/uci-defaults/90-routx-agent ] && /etc/uci-defaults/90-routx-agent',
      '/etc/init.d/routx-agent enable 2>/dev/null',
      '/etc/init.d/routx-agent restart 2>/dev/null',
      'rm -f /tmp/luci-indexcache* 2>/dev/null',
      '[ -x /etc/init.d/rpcd ] && /etc/init.d/rpcd reload 2>/dev/null',
      'exit 0',
      '',
    ].join('\n'),
  );
  await writeFile(
    preDeinstall,
    [
      '#!/bin/sh',
      '/etc/init.d/routx-agent stop 2>/dev/null',
      '/etc/init.d/routx-agent disable 2>/dev/null',
      'exit 0',
      '',
    ].join('\n'),
  );
  await chmod(postInstall, 0o755);
  await chmod(preDeinstall, 0o755);

  execSync(
    [
      'apk mkpkg',
      '--compat 3.0',
      `--output ${JSON.stringify(join(dist, 'routx-agent.apk'))}`,
      `--files ${JSON.stringify(apkRoot)}`,
      '--info name:routx-agent',
      `--info version:${version}-r0`,
      '--info "description:RoutX agent for OpenWrt"',
      '--info arch:noarch',
      '--info license:Apache-2.0',
      '--info origin:routx-agent',
      '--info maintainer:routx',
      '--info "depends:ucode curl"',
      `--script post-install:${JSON.stringify(postInstall)}`,
      `--script post-upgrade:${JSON.stringify(postInstall)}`,
      `--script pre-deinstall:${JSON.stringify(preDeinstall)}`,
    ].join(' '),
    { stdio: 'inherit' },
  );
  await rm(apkRoot, { recursive: true, force: true });
} catch (error) {
  console.log('apk build skipped:', error.message);
}

await writeFile(join(dist, 'routx-agent.version'), `${version}\n`);

const sums = [];
const ipkData = await readFile(join(dist, 'routx-agent.ipk')).catch(() => null);
if (ipkData) {
  sums.push(`${createHash('sha256').update(ipkData).digest('hex')}  routx-agent.ipk`);
}
const apkData = await readFile(join(dist, 'routx-agent.apk')).catch(() => null);
if (apkData) {
  sums.push(`${createHash('sha256').update(apkData).digest('hex')}  routx-agent.apk`);
}
const tarData = await readFile(join(dist, 'routx-agent.tar.gz'));
sums.push(`${createHash('sha256').update(tarData).digest('hex')}  routx-agent.tar.gz`);
await writeFile(join(dist, 'routx-agent.sha256'), `${sums.join('\n')}\n`);
await writeFile(join(dist, 'SHA256SUMS'), `${sums.join('\n')}\n`);

await rm(stage, { recursive: true, force: true });

console.log('built routx-agent ' + version);

// На Windows права 0755 в tar не сохраняются: установленный пакет получит
// неисполняемые /usr/bin/routx-agent и init-скрипт. Для роутера собирайте в Docker.
if (process.platform === 'win32') {
  console.log('warning: Windows не сохраняет exec-биты в tar; для установки собирайте пакет в Docker');
}
