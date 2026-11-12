import type { DiagnosticReportDetail } from '../lib/types';

interface ReportCheck {
  name: string;
  state: string;
  details?: string;
}

interface ReportPayload {
  kind?: string;
  product?: string;
  generated_at?: string;
  checks?: ReportCheck[];
}

type Tone = 'ok' | 'warn' | 'bad' | 'neutral' | 'info';

const CHECK_LABELS: Record<string, string> = {
  service_status: 'Общее состояние службы',
  prokop_service: 'Служба Prokop',
  forkop_service: 'Служба Forkop',
  podkop_service: 'Служба Podkop',
  tachyon_service: 'Служба Tachyon',
  sing_box_service: 'Служба sing-box',
  health_reasons: 'Замечания',
  sing_box_version: 'Версия sing-box',
  prokop_get_status: 'Статус Prokop',
  forkop_get_status: 'Статус Forkop',
  podkop_get_status: 'Статус Podkop',
  tachyon_get_status: 'Статус Tachyon',
  platform: 'Платформа',
  product: 'Продукт',
  global_check: 'Полная проверка',
};

function payloadOf(report: DiagnosticReportDetail): ReportPayload {
  return report.payload && typeof report.payload === 'object'
    ? (report.payload as ReportPayload)
    : {};
}

export function nativeTextOf(report: DiagnosticReportDetail): string | null {
  const check = payloadOf(report).checks?.find((item) => item.name === 'global_check');
  return check?.details && check.details.trim() !== '' ? check.details : null;
}

function toneOf(state: string | undefined): Tone {
  if (state === 'ok' || state === 'success') return 'ok';
  if (state === 'warning' || state === 'warn' || state === 'degraded') return 'warn';
  if (state === 'error' || state === 'failed') return 'bad';
  if (state === 'not_available') return 'neutral';
  return 'info';
}

function iconOf(state: string | undefined): string {
  const tone = toneOf(state);
  if (tone === 'ok') return '✓';
  if (tone === 'warn') return '!';
  if (tone === 'bad') return '×';
  if (tone === 'neutral') return '–';
  return 'i';
}

function labelOf(name: string): string {
  return CHECK_LABELS[name] ?? name.replace(/_/g, ' ');
}

function effectiveTone(check: ReportCheck): Tone {
  if (check.name === 'service_status' && /overall=degraded/i.test(check.details ?? '')) {
    return 'warn';
  }
  return toneOf(check.state);
}

function detailOf(check: ReportCheck): string {
  const details = (check.details ?? '').trim();
  if (check.name === 'service_status' && details.startsWith('overall=')) {
    const value = details.slice('overall='.length);
    if (value === 'ok') return 'Служба работает в штатном режиме';
    if (value === 'degraded') return 'Служба работает, есть предупреждения';
    return `Состояние: ${value}`;
  }
  if (check.name === 'platform' && details.includes('/')) {
    const [version, arch] = details.split('/');
    return `OpenWrt ${version} · ${arch}`;
  }
  if (details === 'ok') return 'Проверка пройдена';
  return shortDetails(details) || 'нет подробностей';
}

function shortDetails(value: string | undefined, max = 220): string {
  const text = (value ?? '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

interface NativeSection {
  title: string;
  lines: string[];
}

function parseNativeSections(text: string): { intro: string[]; sections: NativeSection[] } {
  const lines = text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\r/g, '')
    .split('\n');
  const intro: string[] = [];
  const sections: NativeSection[] = [];
  let current: NativeSection | null = null;
  let expectHeading = true;

  const flush = () => {
    if (!current) return;
    while (current.lines.length > 0 && current.lines[current.lines.length - 1]?.trim() === '') {
      current.lines.pop();
    }
    sections.push(current);
    current = null;
  };

  for (const line of lines) {
    if (/^[━─]{3,}\s*$/.test(line.trim())) {
      flush();
      expectHeading = true;
      continue;
    }
    if (expectHeading) {
      if (line.trim() === '') {
        if (!current && sections.length === 0) intro.push(line);
        continue;
      }
      if (!current && sections.length === 0 && /^📡|^global check/i.test(line.trim())) {
        intro.push(line);
        continue;
      }
      current = { title: line.trim(), lines: [] };
      expectHeading = false;
      continue;
    }
    if (!current) {
      intro.push(line);
      continue;
    }
    current.lines.push(line);
  }
  flush();
  return { intro: intro.filter((line) => line.trim() !== ''), sections };
}

function splitEmoji(line: string): { icon: string; text: string } {
  const trimmed = line.trim();
  const match = /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*(.*)$/u.exec(
    trimmed,
  );
  if (!match) return { icon: '•', text: trimmed };
  return { icon: match[1] ?? '•', text: match[2] ?? '' };
}

function lineTone(line: string): Tone {
  const text = line.trim();
  // Prokop/Forkop сами запускают sing-box и управляют его автозапуском.
  if (/Sing-box autostart disabled/i.test(text)) {
    return text.startsWith('✅') ? 'ok' : 'info';
  }
  if (text.startsWith('✅')) return 'ok';
  if (text.startsWith('⚠️') || text.startsWith('⚠')) return 'warn';
  if (text.startsWith('❌')) return 'bad';
  if (text.startsWith('➖')) return 'neutral';
  return 'info';
}

function lineHint(text: string): string | null {
  if (/Rules mangle counters/i.test(text)) {
    return 'Счётчик относится к трафику LAN-клиентов, который проходит через prerouting. Проверка Prokop запускает запросы с самого роутера, поэтому счётчик может остаться нулевым при исправных правилах. Проверьте: если в разделе «Правила proxy» счётчики растут, перенаправление работает. Для чистой проверки откройте сайт с телефона или компьютера в этой сети и запустите диагностику снова.';
  }
  if (/Sing-box autostart disabled/i.test(text)) {
    return 'Prokop/Forkop сами запускают sing-box и при старте отключают его отдельный автозапуск. ✅ означает, что standalone-автозапуск отключён и sing-box поднимает продукт. ❌ означает, что отдельный автозапуск ещё включён; продукт снимет его при следующем старте. На работу прокси это не влияет.';
  }
  return null;
}

const NATIVE_DIRECT: Record<string, string> = {
  'Global check run!': 'Полная проверка запущена!',
  'System info': 'Система',
  'DNS status': 'Статус DNS',
  'Sing-box status': 'Статус sing-box',
  'NFT rules status': 'Статус NFT-правил',
  'Prokop config': 'Конфигурация Prokop',
  'Prokop configuration validation': 'Проверка конфигурации Prokop',
  'WAN config': 'Конфигурация WAN',
  'FakeIP status': 'Статус FakeIP',
  'DNS on router': 'DNS на роутере',
  '/etc/config/dhcp': 'Конфигурация /etc/config/dhcp',
  'Sing-box installed': 'Sing-box установлен',
  'Sing-box regular build detected': 'Обнаружена обычная сборка sing-box',
  'Sing-box service exist': 'Служба sing-box существует',
  'Sing-box autostart disabled': 'Автозапуск sing-box отключён',
  'Sing-box process running': 'Процесс sing-box запущен',
  'Sing-box listening ports': 'Порты sing-box прослушиваются',
  'Table exist': 'Таблица существует',
  'Rules mangle exist': 'Правила mangle существуют',
  'Rules mangle counters': 'Счётчики правил mangle',
  'Rules mangle output exist': 'Правила mangle output существуют',
  'Rules mangle output counters': 'Счётчики правил mangle output',
  'Rules proxy exist': 'Правила proxy существуют',
  'Rules proxy counters': 'Счётчики правил proxy',
  'No other marking rules found': 'Других правил маркировки не найдено',
  'Prokop configuration is valid': 'Конфигурация Prokop корректна',
};

function translateNative(value: string): string {
  const text = value.trim();
  if (NATIVE_DIRECT[text]) return NATIVE_DIRECT[text];
  let match = /^Sing-box core:\s*(.*)$/i.exec(text);
  if (match) return `Ядро sing-box: ${match[1]}`;
  match = /^Prokop:\s*(.*)$/i.exec(text);
  if (match) return `Prokop: ${match[1]}`;
  match = /^LuCI App:\s*(.*)$/i.exec(text);
  if (match) {
    const value = match[1] ?? '';
    return `LuCI-приложение: ${value.toLowerCase() === 'unknown' ? 'неизвестно' : value}`;
  }
  match = /^Sing-box:\s*(.*)$/i.exec(text);
  if (match) return `Sing-box: ${match[1]}`;
  match = /^OpenWrt:\s*(.*)$/i.exec(text);
  if (match) return `OpenWrt: ${match[1]}`;
  match = /^Device:\s*(.*)$/i.exec(text);
  if (match) return `Устройство: ${match[1]}`;
  match = /^Bootstrap DNS:\s*(.*?)\s*\(not used: the main DNS server is an IP address\)$/i.exec(text);
  if (match) return `Bootstrap DNS: ${match[1]} (не используется: основной DNS задан IP-адресом)`;
  match = /^Main DNS:\s*(.*)$/i.exec(text);
  if (match) return `Основной DNS: ${match[1]}`;
  match = /^Sing-box version is compatible \(newer than (.*)\)$/i.exec(text);
  if (match) return `Версия sing-box совместима (новее ${match[1]})`;
  match = /^Sing-box FakeIP DNS works:\s*(.*)$/i.exec(text);
  if (match) return `FakeIP DNS sing-box работает: ${match[1]}`;

  return text.replace(/MASKED/g, '[скрыто]');
}

function translateNativeWithEmoji(value: string): string {
  const { icon, text } = splitEmoji(value);
  const translated = translateNative(text);
  return icon === '•' ? translated : `${icon} ${translated}`;
}

function translateConfig(value: string): string {
  return value.replace(/MASKED/g, '[скрыто]');
}

export function translateNativeReport(text: string): string {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => {
      const leading = /^\s*/.exec(line)?.[0] ?? '';
      return leading + translateNativeWithEmoji(line.trim());
    })
    .join('\n');
}

function isConfigSection(section: NativeSection): boolean {
  return section.lines.some((line) => line.trim().startsWith('config '));
}

function NativeSectionView({ section }: { section: NativeSection }) {
  const config = isConfigSection(section);
  const title = translateNativeWithEmoji(section.title);
  return (
    <section className="diag-native-section">
      <header className="diag-native-head">
        <span className="diag-native-title">{title}</span>
        <span className="diag-native-count">
          {config
            ? 'config'
            : `${section.lines.filter((line) => line.trim()).length} ${plural(
                section.lines.filter((line) => line.trim()).length,
                'строка',
                'строки',
                'строк',
              )}`}
        </span>
      </header>
      {config ? (
        <pre className="diag-config">{translateConfig(section.lines.join('\n').trim())}</pre>
      ) : (
        <ul className="diag-native-lines">
          {section.lines.map((line, index) => {
            const trimmed = line.trim();
            if (!trimmed) return null;
            const tone = lineTone(trimmed);
            const { icon, text } = splitEmoji(trimmed);
            const hint = lineHint(text || trimmed);
            const autostartLine = /Sing-box autostart disabled/i.test(text);
            const autostartBad = autostartLine && icon.startsWith('❌');
            const displayIcon = autostartBad ? 'ℹ️' : icon;
            const displayText = autostartBad
              ? 'Отдельный автозапуск sing-box включён (продукт отключит его при старте)'
              : translateNative(text || trimmed);
            return (
              <li key={`${index}-${trimmed.slice(0, 12)}`} className={`diag-line diag-line-${tone}`}>
                <span className="diag-line-icon" aria-hidden="true">
                  {displayIcon}
                </span>
                <div className="diag-line-body">
                  <span>{displayText}</span>
                  {hint ? <span className="diag-line-hint">{hint}</span> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function DiagnosticReportView({ report }: { report: DiagnosticReportDetail }) {
  const payload = payloadOf(report);
  const checks = payload.checks ?? [];
  const visibleChecks = checks.filter((check) => check.name !== 'global_check');
  const nativeText = nativeTextOf(report);
  const native = nativeText ? parseNativeSections(nativeText) : null;

  const counts = { ok: 0, warn: 0, bad: 0, neutral: 0, info: 0 };
  for (const check of visibleChecks) counts[effectiveTone(check)] += 1;
  if (native) {
    for (const section of native.sections) {
      for (const line of section.lines) {
        counts[lineTone(line)] += 1;
      }
    }
  }
  const total = counts.ok + counts.warn + counts.bad + counts.neutral + counts.info;
  const scored = counts.ok + counts.warn + counts.bad;
  const percent = scored > 0 ? Math.round((counts.ok / scored) * 100) : 0;
  const overall: Tone =
    counts.bad > 0 ? 'bad' : counts.warn > 0 ? 'warn' : counts.ok > 0 ? 'ok' : 'neutral';
  const overallTitle =
    overall === 'ok'
      ? 'Всё в порядке'
      : overall === 'warn'
        ? 'Есть предупреждения'
        : overall === 'bad'
          ? 'Есть ошибки'
          : 'Нет данных';
  const kindLabel = report.kind === 'full' ? 'Полная диагностика' : 'Быстрая диагностика';

  return (
    <div className={`diag-report diag-report-${overall}`}>
      <div className="diag-hero">
        <div className="diag-orbit" aria-hidden="true">
          <span className="diag-orbit-ring diag-orbit-ring-a" />
          <span className="diag-orbit-ring diag-orbit-ring-b" />
          <span className="diag-orbit-core">{overall === 'ok' ? '✓' : overall === 'warn' ? '!' : overall === 'bad' ? '×' : '–'}</span>
        </div>
        <div className="diag-hero-body">
          <p className="eyebrow">
            {kindLabel} · {report.product}
          </p>
          <h2>{overallTitle}</h2>
          <p className="page-sub">
            {counts.ok} успешно · {counts.warn}{' '}
            {plural(counts.warn, 'предупреждение', 'предупреждения', 'предупреждений')} ·{' '}
            {counts.bad} {plural(counts.bad, 'ошибка', 'ошибки', 'ошибок')}
            {counts.neutral > 0 ? ` · ${counts.neutral} недоступно` : ''}
          </p>
          <div className="diag-meter" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${percent}%` }} />
          </div>
          <p className="diag-hero-meta">
            {payload.generated_at ? new Date(payload.generated_at).toLocaleString('ru-RU') : report.created_at}
            {' · '}
            {report.agent_version ? `агент ${report.agent_version}` : 'агент неизвестен'}
          </p>
        </div>
      </div>

      {visibleChecks.length > 0 ? (
        <div className="diag-checks">
          {visibleChecks.map((check, index) => {
            const tone = effectiveTone(check);
            return (
              <article
                key={check.name}
                className={`diag-check diag-check-${tone}`}
                style={{ animationDelay: `${index * 70}ms` }}
              >
                <span className="diag-check-icon" aria-hidden="true">
                  {iconOf(tone === 'warn' ? 'warning' : check.state)}
                </span>
                <div className="diag-check-body">
                  <h3>{labelOf(check.name)}</h3>
                  <p>{detailOf(check)}</p>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}

      {native ? (
        <div className="diag-native">
          {native.intro.length > 0 ? (
            <div className="diag-native-intro">
              {native.intro.map((line, index) => (
                <p key={`${index}-${line.slice(0, 12)}`}>{translateNativeWithEmoji(line)}</p>
              ))}
            </div>
          ) : null}
          {native.sections.map((section) => (
            <NativeSectionView key={section.title} section={section} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
