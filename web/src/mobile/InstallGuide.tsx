/**
 * Инструкция по установке PWA внутри самого приложения.
 * Оформлена мобильными классами m-*, а не стилями панели.
 */
export function InstallGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="m-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="m-sheet m-sheet-tall" onClick={(event) => event.stopPropagation()}>
        <div className="m-sheet-grip" />
        <h2 className="m-sheet-title">Установить RoutX</h2>
        <p className="m-lead">
          RoutX работает как PWA: отдельная иконка на домашнем экране, без адресной строки.
          Магазин приложений не нужен.
        </p>
        <ol className="m-guide">
          <li>
            <strong>Откройте страницу в браузере.</strong> Если она открылась внутри Telegram,
            WhatsApp или другого приложения, нажмите «Открыть в браузере».
          </li>
          <li>
            <strong>Android (Chrome):</strong> меню ⋮ → «Установить приложение» или «Добавить на
            главный экран».
          </li>
          <li>
            <strong>iPhone / iPad (Safari):</strong> «Поделиться» → «На экран „Домой“» →
            «Добавить». В Chrome на iPhone установка PWA недоступна — нужен Safari.
          </li>
          <li>
            <strong>Компьютер (Chrome или Edge):</strong> значок установки в адресной строке.
          </li>
          <li>Откройте RoutX с домашнего экрана — вход сохранится.</li>
        </ol>
        <div className="m-sheet-actions">
          <button type="button" className="m-action m-action-sm" onClick={onClose}>
            Понятно
          </button>
        </div>
      </div>
    </div>
  );
}
