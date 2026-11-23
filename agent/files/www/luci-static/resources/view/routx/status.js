'use strict';
'require view';
'require fs';
'require poll';
'require ui';

const STATUS_PATH = '/var/run/routx-agent/status.json';
const FRESH_SECONDS = 150;

const STYLE = `
.jn-wrap { max-width: 820px; }

.jn-hero {
	display: flex;
	align-items: center;
	gap: 18px;
	padding: 22px 24px;
	border: 1px solid var(--border-color-low, rgba(128, 128, 128, .25));
	border-radius: 16px;
	background: var(--background-color-high, rgba(128, 128, 128, .05));
}

.jn-orb {
	position: relative;
	display: flex;
	align-items: center;
	justify-content: center;
	flex: 0 0 auto;
	width: 54px;
	height: 54px;
	border-radius: 50%;
	color: #7a7f87;
	background: rgba(122, 127, 135, .14);
}

.jn-orb::before {
	content: '';
	position: absolute;
	inset: -6px;
	border: 2px solid currentColor;
	border-radius: 50%;
	opacity: .18;
}

.jn-orb::after {
	content: '';
	width: 16px;
	height: 16px;
	border-radius: 50%;
	background: currentColor;
}

.jn-orb.jn-live::before {
	animation: jn-pulse 2.6s ease-out infinite;
}

@keyframes jn-pulse {
	0% { transform: scale(.9); opacity: .45; }
	70% { transform: scale(1.22); opacity: 0; }
	100% { transform: scale(1.22); opacity: 0; }
}

.jn-hero-text { min-width: 0; }

.jn-title {
	font-size: 1.35rem;
	font-weight: 600;
	line-height: 1.2;
	letter-spacing: -.01em;
}

.jn-sub {
	margin-top: 5px;
	font-size: .82rem;
	opacity: .62;
}

.jn-badge {
	margin-left: auto;
	padding: 7px 13px;
	border-radius: 999px;
	font-size: .76rem;
	font-weight: 600;
	white-space: nowrap;
}

.jn-badge.jn-ok { color: #18824a; background: rgba(24, 130, 74, .13); }
.jn-badge.jn-warn { color: #a86400; background: rgba(168, 100, 0, .14); }
.jn-badge.jn-bad { color: #bf3a2b; background: rgba(191, 58, 43, .13); }
.jn-badge.jn-muted { color: #71767e; background: rgba(113, 118, 126, .14); }

.jn-orb.jn-ok { color: #1e9b57; background: rgba(30, 155, 87, .15); }
.jn-orb.jn-warn { color: #c07d10; background: rgba(192, 125, 16, .15); }
.jn-orb.jn-bad { color: #c9483a; background: rgba(201, 72, 58, .15); }

.jn-grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
	gap: 12px;
	margin-top: 14px;
}

.jn-cell {
	padding: 14px 16px;
	border: 1px solid var(--border-color-low, rgba(128, 128, 128, .22));
	border-radius: 12px;
	background: var(--background-color-high, rgba(128, 128, 128, .035));
}

.jn-label {
	font-size: .68rem;
	font-weight: 600;
	letter-spacing: .07em;
	text-transform: uppercase;
	opacity: .5;
}

.jn-value {
	margin-top: 7px;
	font-size: .93rem;
	font-weight: 600;
	line-height: 1.35;
	overflow-wrap: anywhere;
}

.jn-value a { font-weight: 600; }

.jn-value small {
	display: block;
	margin-top: 3px;
	font-size: .73rem;
	font-weight: 400;
	opacity: .55;
}

.jn-note {
	display: none;
	margin-top: 14px;
	padding: 12px 15px;
	border-radius: 12px;
	border-left: 3px solid currentColor;
	font-size: .84rem;
	line-height: 1.45;
	background: rgba(128, 128, 128, .07);
}

.jn-note.jn-visible { display: block; }
.jn-note.jn-ok { color: #18824a; }
.jn-note.jn-warn { color: #a86400; }
.jn-note.jn-bad { color: #bf3a2b; }
.jn-note.jn-muted { color: #71767e; }

.jn-actions {
	display: flex;
	flex-wrap: wrap;
	gap: 10px;
	margin-top: 18px;
}

.jn-footer {
	margin-top: 13px;
	font-size: .73rem;
	opacity: .45;
	overflow-wrap: anywhere;
}

@media (max-width: 560px) {
	.jn-hero { flex-wrap: wrap; }
	.jn-badge { margin-left: 0; }
}

[data-darkmode="true"] .jn-badge.jn-ok,
[data-darkmode="true"] .jn-note.jn-ok { color: #57d38c; }
[data-darkmode="true"] .jn-orb.jn-ok { color: #57d38c; background: rgba(87, 211, 140, .16); }

[data-darkmode="true"] .jn-badge.jn-warn,
[data-darkmode="true"] .jn-note.jn-warn { color: #e7b45a; }
[data-darkmode="true"] .jn-orb.jn-warn { color: #e7b45a; background: rgba(231, 180, 90, .16); }

[data-darkmode="true"] .jn-badge.jn-bad,
[data-darkmode="true"] .jn-note.jn-bad { color: #f08a7e; }
[data-darkmode="true"] .jn-orb.jn-bad { color: #f08a7e; background: rgba(240, 138, 126, .16); }

[data-darkmode="true"] .jn-badge.jn-muted,
[data-darkmode="true"] .jn-note.jn-muted { color: #9aa0a8; }
[data-darkmode="true"] .jn-orb { color: #9aa0a8; background: rgba(154, 160, 168, .16); }

.jn-mobile {
	margin-top: 14px;
	padding: 16px 18px;
	border: 1px solid var(--border-color-low, rgba(128, 128, 128, .22));
	border-radius: 12px;
	background: var(--background-color-high, rgba(128, 128, 128, .035));
}

.jn-mobile-head {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 12px;
	flex-wrap: wrap;
}

.jn-mobile-title {
	font-size: .95rem;
	font-weight: 600;
}

.jn-mobile-text {
	margin-top: 6px;
	max-width: 46em;
	font-size: .82rem;
	line-height: 1.5;
	opacity: .62;
}

.jn-qr-result { margin-top: 14px; }

.jn-devices { margin-top: 6px; }

.jn-device {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 11px 0;
	border-top: 1px solid var(--border-color-low, rgba(128, 128, 128, .18));
}

.jn-device-main { flex: 1; min-width: 0; }

.jn-device-name {
	font-size: .9rem;
	font-weight: 600;
	overflow-wrap: anywhere;
}

.jn-device-meta {
	margin-top: 2px;
	font-size: .74rem;
	opacity: .6;
}

.jn-device-empty {
	margin-top: 10px;
	font-size: .82rem;
	opacity: .6;
}

.jn-mobile-actions {
	display: flex;
	align-items: center;
	gap: 10px;
	flex-wrap: wrap;
}

.jn-qr-status {
	font-size: .78rem;
	opacity: .6;
}

.jn-qr-wrap {
	display: flex;
	flex-wrap: wrap;
	gap: 18px;
	align-items: flex-start;
}

.jn-qr {
	width: 220px;
	height: 220px;
	padding: 8px;
	border-radius: 10px;
	background: #fff;
}

.jn-qr-meta {
	flex: 1 1 220px;
	min-width: 0;
	font-size: .82rem;
	line-height: 1.55;
}

.jn-qr-meta strong { font-weight: 600; }

.jn-qr-url {
	margin-top: 6px;
	font-family: monospace;
	font-size: .74rem;
	opacity: .6;
	overflow-wrap: anywhere;
}

.jn-qr-hint {
	margin-top: 8px;
	opacity: .6;
}

.jn-qr-warn {
	margin-top: 8px;
	color: #a86400;
}

.jn-qr-error {
	margin-top: 10px;
	font-size: .82rem;
	color: #bf3a2b;
}

.jn-qr-error:empty { display: none; }

[data-darkmode="true"] .jn-qr-warn { color: #e7b45a; }
[data-darkmode="true"] .jn-qr-error { color: #f08a7e; }

@media (max-width: 560px) {
	.jn-mobile-head .btn { width: 100%; }
}
`;

function parse(raw) {
	try {
		const value = JSON.parse(raw || '');
		return (value && typeof value === 'object') ? value : null;
	}
	catch (e) {
		return null;
	}
}

function secondsSince(iso) {
	if (!iso)
		return null;
	const t = Date.parse(iso);
	if (isNaN(t))
		return null;
	return Math.max(0, Math.round((Date.now() - t) / 1000));
}

function humanAge(seconds) {
	if (seconds == null)
		return '—';
	if (seconds < 5)
		return 'только что';
	if (seconds < 60)
		return seconds + ' с назад';
	if (seconds < 3600)
		return Math.round(seconds / 60) + ' мин назад';
	if (seconds < 86400)
		return Math.round(seconds / 3600) + ' ч назад';
	return Math.round(seconds / 86400) + ' дн назад';
}

function productLabel(product) {
	if (product === 'prokop')
		return 'Prokop';
	if (product === 'forkop')
		return 'Forkop';
	if (product === 'podkop')
		return 'Podkop';
	if (product === 'conflict')
		return 'Конфликт';
	return 'не определён';
}

function toneClass(tone) {
	return tone === 'ok' ? 'jn-ok' : tone === 'warn' ? 'jn-warn' : tone === 'bad' ? 'jn-bad' : 'jn-muted';
}

return view.extend({
	load: function() {
		return fs.read(STATUS_PATH)
			.then(parse)
			.catch(() => null);
	},

	setValue: function(node, primary, secondary) {
		while (node.firstChild)
			node.removeChild(node.firstChild);
		node.appendChild(document.createTextNode(primary == null || primary === '' ? '—' : String(primary)));
		if (secondary) {
			const small = E('small', {}, secondary);
			node.appendChild(small);
		}
	},

	setServer: function(node, server) {
		while (node.firstChild)
			node.removeChild(node.firstChild);
		if (!server) {
			node.appendChild(document.createTextNode('—'));
			return;
		}
		if (/^https?:\/\//i.test(server)) {
			node.appendChild(E('a', {
				'href': server,
				'target': '_blank',
				'rel': 'noopener noreferrer'
			}, server));
		}
		else {
			node.appendChild(document.createTextNode(server));
		}
		node.appendChild(E('small', {}, 'RoutX'));
	},

	paint: function(root, status) {
		const r = root.jnRefs;
		const st = status || {};

		let tone = 'muted';
		let label = 'Нет данных';
		let detail = 'Агент ещё не записал статус';

		if (status) {
			const enabled = st.enabled !== false;
			const bound = st.bound === true;
			const age = secondsSince(st.updated_at);
			const fresh = age != null && age < FRESH_SECONDS;
			const error = String(st.last_error || '').trim();

			if (st.product === 'conflict') {
				tone = 'bad';
				label = 'Конфликт продуктов';
				detail = 'Prokop и Forkop найдены одновременно';
			}
			else if (!enabled) {
				tone = 'muted';
				label = 'Отключён';
				detail = 'Агент остановлен в конфигурации';
			}
			else if (!bound) {
				tone = 'warn';
				label = 'Ожидает привязки';
				detail = 'Нужен токен из карточки роутера';
			}
			else if (!fresh) {
				tone = 'bad';
				label = 'Не отвечает';
				detail = 'Статус не обновлялся ' + humanAge(age);
			}
			else if (error) {
				tone = 'warn';
				label = 'Нет связи';
				detail = error;
			}
			else {
				tone = 'ok';
				label = 'Подключён';
				detail = 'Связь с сервером активна';
			}
		}

		const toneCls = toneClass(tone);
		r.orb.className = 'jn-orb ' + toneCls + (tone === 'ok' ? ' jn-live' : '');
		r.badge.className = 'jn-badge ' + toneCls;
		r.badge.textContent = label;

		const product = st.product || '';
		const productVersion = st.product_version || '';
		r.sub.textContent = product
			? productLabel(product) + (productVersion ? ' ' + productVersion : '') + ' · агент ' + (st.agent_version || '?')
			: 'Агент VPN на роутере';

		this.setServer(r.server, st.server || '');
		this.setValue(r.router, st.router_id ? String(st.router_id) : '—', productLabel(product));
		this.setValue(r.product, productLabel(product), productVersion ? 'версия ' + productVersion : '');

		const sbVersion = st.sing_box_version || '';
		const sbVariant = st.sing_box_variant || '';
		this.setValue(
			r.singbox,
			sbVersion || 'не установлен',
			sbVariant ? 'вариант ' + sbVariant : ''
		);

		this.setValue(
			r.agent,
			st.agent_version ? 'v' + st.agent_version : '—',
			'обновлён ' + humanAge(secondsSince(st.updated_at))
		);

		const model = st.model || '';
		const openwrt = st.openwrt || '';
		this.setValue(
			r.system,
			model || openwrt || '—',
			[openwrt ? 'OpenWrt ' + openwrt : '', st.arch || ''].filter(Boolean).join(' · ')
		);

		const notes = [];
		if (!status) {
			notes.push('Агент ещё не записал файл статуса. Если установка только что завершилась, подождите несколько секунд и нажмите «Обновить».');
		}
		else if (st.product === 'conflict') {
			notes.push('На роутере одновременно найдены Prokop и Forkop. RoutX не вносит изменений, пока конфликт не устранён вручную.');
		}
		else if (st.enabled === false) {
			notes.push('Агент отключён: в /etc/config/routx указано enabled=0.');
		}
		else if (st.bound !== true) {
			notes.push('Агент установлен, но не привязан. Возьмите одноразовую команду установки в карточке роутера на сервере.');
		}
		else if (secondsSince(st.updated_at) == null || secondsSince(st.updated_at) >= FRESH_SECONDS) {
			notes.push('Статус не обновлялся более двух минут. Проверьте /etc/init.d/routx-agent status и журнал: logread -e routx-agent.');
		}
		else if (String(st.last_error || '').trim()) {
			notes.push('Последняя ошибка связи: ' + String(st.last_error).trim());
		}

		if (notes.length) {
			r.note.className = 'jn-note ' + toneCls + ' jn-visible';
			r.note.textContent = notes.join(' ');
		}
		else {
			r.note.className = 'jn-note';
			r.note.textContent = '';
		}

		r.footer.textContent = [
			'RoutX',
			'последний опрос: ' + humanAge(secondsSince(st.last_poll_at)),
			'статус обновлён: ' + humanAge(secondsSince(st.updated_at))
		].join(' · ');
	},

	reload: function(root) {
		return fs.read(STATUS_PATH)
			.then(parse)
			.catch(() => null)
			.then((status) => {
				this.paint(root, status);
				return status;
			});
	},

	handleRefresh: function(root) {
		return this.reload(root);
	},

	handleRestart: function(root) {
		ui.showModal('Перезапустить агент RoutX?', [
			E('p', {}, 'Агент ненадолго прервёт связь с сервером и затем подключится снова. Настройки роутера не изменятся.'),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn',
					'click': ui.hideModal
				}, 'Отмена'),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-apply',
					'click': ui.createHandlerFn(this, function() {
						return fs.exec('/etc/init.d/routx-agent', [ 'restart' ])
							.then(() => {
								ui.hideModal();
								ui.addNotification(null, E('p', {}, 'Агент перезапущен'), 'info');
								window.setTimeout(() => this.reload(root), 2500);
							})
							.catch((e) => {
								ui.hideModal();
								ui.addNotification(null, E('p', {}, 'Не удалось перезапустить: ' + e.message), 'error');
							});
					})
				}, 'Перезапустить')
			])
		]);
	},

	handleRotate: function(root) {
		ui.showModal('Сменить секрет агента?', [
			E('p', {}, 'Агент получит новый токен и сохранит его только на роутере. Старый токен перестанет действовать через 10 минут. Привязка и настройки роутера не изменятся.'),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn',
					'click': ui.hideModal
				}, 'Отмена'),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-apply',
					'click': ui.createHandlerFn(this, function() {
						return fs.exec('/usr/bin/routx-agent', [ 'rotate' ])
							.then((res) => {
								if (res.code !== 0)
									throw new Error((res.stderr || res.stdout || ('код ' + res.code)).trim());
								ui.hideModal();
								ui.addNotification(null, E('p', {}, 'Секрет обновлён. Агент переподключится автоматически.'), 'info');
								window.setTimeout(() => this.reload(root), 1500);
							})
							.catch((e) => {
								ui.hideModal();
								ui.addNotification(null, E('p', {}, 'Не удалось сменить секрет: ' + e.message), 'error');
							});
					})
				}, 'Сменить')
			])
		]);
	},

	handleMobileQr: function(root) {
		const r = root.jnRefs;

		r.qrError.textContent = '';
		r.qrResult.innerHTML = '';
		r.qrStatus.textContent = 'Создаём одноразовую ссылку…';

		const finish = () => {
			r.qrStatus.textContent = '';
		};

		return fs.exec('/usr/bin/routx-agent', [ 'mobile-qr' ])
			.then((res) => {
				const lines = String(res.stdout || '').split('\n').filter((line) => line.trim() !== '');
				let data = null;
				try {
					data = JSON.parse(lines.length ? lines[lines.length - 1] : '');
				}
				catch (e) {
					data = null;
				}

				if (res.code !== 0 || !data || data.ok !== true)
					throw new Error((data && data.error) || String(res.stderr || '').trim() || 'агент не вернул ссылку');

				this.showMobileQr(root, data);
			})
			.catch((e) => {
				r.qrResult.innerHTML = '';
				r.qrError.textContent = 'Не удалось создать QR: ' + e.message;
			})
			.then(finish, finish);
	},

	showMobileQr: function(root, data) {
		const r = root.jnRefs;
		r.qrError.textContent = '';
		r.qrResult.innerHTML = '';

		const image = E('img', {
			'class': 'jn-qr',
			'src': data.qr,
			'alt': 'QR-код для входа с телефона'
		});

		const expires = data.expires_at ? new Date(data.expires_at) : null;
		const meta = E('div', { 'class': 'jn-qr-meta' }, [
			E('div', {}, [
				E('strong', {}, 'Действует до '),
				expires && !isNaN(expires.getTime())
					? expires.toLocaleTimeString()
					: '5 минут'
			]),
			E('div', { 'class': 'jn-qr-url' }, data.url),
			E('div', { 'class': 'jn-qr-hint' }, 'Наведите камеру телефона: вход выполнится автоматически и откроется страница установки приложения. На ней есть шаги для Android и iPhone. Ссылка одноразовая — после входа она перестанет работать.')
		]);

		if (data.https === false) {
			meta.appendChild(E('div', { 'class': 'jn-qr-warn' }, 'Панель открыта по HTTP. Установка приложения на iPhone/Android может не работать — укажите HTTPS-адрес панели в настройках сервера.'));
		}

		meta.appendChild(E('div', { 'class': 'jn-actions' }, [
			E('a', {
				'class': 'btn cbi-button',
				'href': data.url,
				'target': '_blank',
				'rel': 'noopener noreferrer'
			}, 'Открыть ссылку')
		]));

		r.qrResult.appendChild(E('div', { 'class': 'jn-qr-wrap' }, [ image, meta ]));
	},

	/* Авторизованные телефоны: список читается у сервера через агента.
	   Удаление меняет только это устройство, остальные телефоны остаются. */
	reloadDevices: function(root) {
		const r = root.jnRefs;
		r.devicesStatus.textContent = 'Читаем список…';
		r.devicesList.innerHTML = '';
		r.devicesNote.textContent = '';

		const finish = () => {
			r.devicesStatus.textContent = '';
		};

		return fs.exec('/usr/bin/routx-agent', [ 'mobile-devices' ])
			.then((res) => {
				const lines = String(res.stdout || '').split('\n').filter((line) => line.trim() !== '');
				let data = null;
				try {
					data = JSON.parse(lines.length ? lines[lines.length - 1] : '');
				}
				catch (e) {
					data = null;
				}

				if (res.code !== 0 || !data || data.ok !== true)
					throw new Error((data && data.error) || String(res.stderr || '').trim() || 'агент не вернул список');

				const items = Array.isArray(data.items) ? data.items : [];
				if (items.length === 0) {
					r.devicesNote.textContent = 'Пока нет авторизованных телефонов.';
					return;
				}

				for (const item of items)
					r.devicesList.appendChild(this.deviceRow(root, item));
			})
			.catch((e) => {
				r.devicesNote.textContent = 'Не удалось прочитать список: ' + e.message;
			})
			.then(finish, finish);
	},

	deviceRow: function(root, item) {
		const created = item.created_at ? new Date(item.created_at) : null;
		const seen = item.last_seen_at ? new Date(item.last_seen_at) : null;

		const meta = [];
		if (created && !isNaN(created.getTime()))
			meta.push('добавлено ' + created.toLocaleDateString() + ' ' + created.toLocaleTimeString().slice(0, 5));
		if (seen && !isNaN(seen.getTime()))
			meta.push('активность: ' + this.humanSeen(seen));

		return E('div', { 'class': 'jn-device' }, [
			E('div', { 'class': 'jn-device-main' }, [
				E('div', { 'class': 'jn-device-name' }, item.name || 'Устройство'),
				E('div', { 'class': 'jn-device-meta' }, meta.join(' · '))
			]),
			E('button', {
				'class': 'btn cbi-button cbi-button-negative',
				'click': ui.createHandlerFn(this, function() {
					return this.handleRevokeDevice(root, item);
				})
			}, 'Удалить')
		]);
	},

	humanSeen: function(date) {
		const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
		if (seconds < 60) return 'только что';
		if (seconds < 3600) return Math.round(seconds / 60) + ' мин назад';
		if (seconds < 86400) return Math.round(seconds / 3600) + ' ч назад';
		return Math.round(seconds / 86400) + ' дн назад';
	},

	handleRevokeDevice: function(root, device) {
		ui.showModal('Удалить устройство?', [
			E('p', {}, 'Телефон «' + (device.name || 'Устройство') + '» выйдет из панели RoutX. Чтобы вернуть доступ, отсканируйте новый QR на этой странице.'),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn',
					'click': ui.hideModal
				}, 'Отмена'),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-negative',
					'click': ui.createHandlerFn(this, function() {
						return fs.exec('/usr/bin/routx-agent', [ 'mobile-revoke', device.id ])
							.then((res) => {
								const lines = String(res.stdout || '').split('\n').filter((line) => line.trim() !== '');
								let data = null;
								try {
									data = JSON.parse(lines.length ? lines[lines.length - 1] : '');
								}
								catch (e) {
									data = null;
								}

								if (res.code !== 0 || !data || data.ok !== true)
									throw new Error((data && data.error) || String(res.stderr || '').trim() || 'агент не подтвердил удаление');

								ui.hideModal();
								ui.addNotification(null, E('p', {}, 'Устройство удалено'), 'info');
								return this.reloadDevices(root);
							})
							.catch((e) => {
								ui.hideModal();
								ui.addNotification(null, E('p', {}, 'Не удалось удалить: ' + e.message), 'error');
							});
					})
				}, 'Удалить')
			])
		]);
	},

	render: function(status) {
		const refs = {};

		const orb = E('div', { 'class': 'jn-orb jn-muted' });
		const badge = E('span', { 'class': 'jn-badge jn-muted' }, 'Проверка…');
		const sub = E('div', { 'class': 'jn-sub' }, 'Агент VPN на роутере');

		const hero = E('div', { 'class': 'jn-hero' }, [
			orb,
			E('div', { 'class': 'jn-hero-text' }, [
				E('div', { 'class': 'jn-title' }, 'RoutX'),
				sub
			]),
			badge
		]);

		const cell = (label, key) => {
			const value = E('div', { 'class': 'jn-value' }, '—');
			refs[key] = value;
			return E('div', { 'class': 'jn-cell' }, [
				E('div', { 'class': 'jn-label' }, label),
				value
			]);
		};

		const grid = E('div', { 'class': 'jn-grid' }, [
			cell('Сервер', 'server'),
			cell('Роутер', 'router'),
			cell('Продукт', 'product'),
			cell('sing-box', 'singbox'),
			cell('Агент', 'agent'),
			cell('Система', 'system')
		]);

		const note = E('div', { 'class': 'jn-note' });
		const footer = E('div', { 'class': 'jn-footer' });

		const qrButton = E('button', {
			'class': 'btn cbi-button cbi-button-action',
			'click': ui.createHandlerFn(this, function() { return this.handleMobileQr(root); })
		}, 'Показать QR для телефона');

		const qrStatus = E('span', { 'class': 'jn-qr-status' }, '');
		const qrResult = E('div', { 'class': 'jn-qr-result' });
		const qrError = E('div', { 'class': 'jn-qr-error' });

		const mobile = E('div', { 'class': 'jn-mobile' }, [
			E('div', { 'class': 'jn-mobile-head' }, [
				E('div', {}, [
					E('div', { 'class': 'jn-mobile-title' }, 'Мобильный доступ'),
					E('div', { 'class': 'jn-mobile-text' },
						'QR открывает панель RoutX на телефоне и сразу входит владельцем роутера. ' +
						'После входа откроется страница установки приложения с шагами для Android и iPhone. ' +
						'Ссылка одноразовая и действует 5 минут. Новый QR добавляет ещё один телефон и не отключает предыдущие.')
				]),
				E('div', { 'class': 'jn-mobile-actions' }, [ qrButton, qrStatus ])
			]),
			qrResult,
			qrError
		]);

		const devicesList = E('div', { 'class': 'jn-devices' });
		const devicesNote = E('div', { 'class': 'jn-device-empty' }, '');
		const devicesStatus = E('span', { 'class': 'jn-qr-status' }, '');
		const devicesRefresh = E('button', {
			'class': 'btn cbi-button',
			'click': ui.createHandlerFn(this, function() { return this.reloadDevices(root); })
		}, 'Обновить список');

		const devices = E('div', { 'class': 'jn-mobile' }, [
			E('div', { 'class': 'jn-mobile-head' }, [
				E('div', {}, [
					E('div', { 'class': 'jn-mobile-title' }, 'Авторизованные устройства'),
					E('div', { 'class': 'jn-mobile-text' },
						'Телефоны, которые вошли по QR. Удалить устройство может только владелец роутера — здесь. ' +
						'После удаления телефон выйдет из панели, остальные останутся.')
				]),
				E('div', { 'class': 'jn-mobile-actions' }, [ devicesRefresh, devicesStatus ])
			]),
			devicesList,
			devicesNote
		]);

		const root = E('div', { 'class': 'jn-wrap' }, [
			E('style', {}, STYLE),
			hero,
			grid,
			note,
			mobile,
			devices,
			E('div', { 'class': 'jn-actions' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, function() { return this.handleRefresh(root); })
				}, 'Обновить'),
				E('button', {
					'class': 'btn cbi-button',
					'click': ui.createHandlerFn(this, function() { return this.handleRestart(root); })
				}, 'Перезапустить агент'),
				E('button', {
					'class': 'btn cbi-button',
					'click': ui.createHandlerFn(this, function() { return this.handleRotate(root); })
				}, 'Сменить секрет')
			]),
			footer
		]);

		refs.orb = orb;
		refs.badge = badge;
		refs.sub = sub;
		refs.note = note;
		refs.footer = footer;
		refs.qrButton = qrButton;
		refs.qrStatus = qrStatus;
		refs.qrResult = qrResult;
		refs.qrError = qrError;
		refs.devicesList = devicesList;
		refs.devicesNote = devicesNote;
		refs.devicesStatus = devicesStatus;
		root.jnRefs = refs;

		this.paint(root, status);
		void this.reloadDevices(root);

		poll.add(() => this.reload(root), 10);

		return root;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
