// RoutX: демон
const fs = require("fs");
const util = require("jn_util");
const config = require("jn_config");
const store = require("jn_store");
const platform = require("jn_platform");
const client = require("jn_client");
const ops = require("jn_ops");
const snaps = require("jn_snapshots");
const diag = require("jn_diagnostics");
const uci_state = require("jn_uci_state");
const monitor = require("jn_monitor");
const self_update = require("jn_self_update");
const dns_benchmark = require("jn_dns_benchmark");
const runner = require("jn_run");

function handle_command(cmd) {
	let id = cmd.id;
	let op = cmd.op;
	let args = type(cmd.args) == "object" ? cmd.args : {};
	let product = platform.detect_product();
	// При конфликте продуктов разрешаем только явную смену продукта и probe:
	// именно product_switch устраняет конфликт, удаляя лишние продукты.
	if (product == "conflict" && op != "product_switch" && op != "product_probe" && op != "self_update")
		return { status: "failed", error: { code: "product_conflict", message: "Оба продукта обнаружены" } };
	if (product == "unknown" && op != "product_switch")
		return { status: "failed", error: { code: "product_unknown", message: "Продукт не определён" } };

	try {
		if (op == "read_state") {
			let r = uci_state.build_read_state(product);
			return { status: "success", result: r };
		}
		if (op == "read_rules") {
			let res = ops.read_rules(product);
			if (!res.ok) return { status: "failed", error: { code: "read_rules_failed", message: util.as_string(res.error) } };
			return { status: "success", result: res };
		}
		if (op == "product_probe") {
			return { status: "success", result: client.build_probe(product) };
		}
		if (op == "precheck") {
			return { status: "success", result: ops.precheck(product) };
		}
		if (op == "verify") {
			return { status: "success", result: ops.verify(product) };
		}
		if (op == "service_action") {
			let res = ops.service_action(product, args.action);
			if (!res.ok) return { status: "failed", error: { code: "service_action_failed", message: res.error } };
			return { status: "success", result: res };
		}
		if (op == "reboot") {
			// Результат должен уйти на сервер до перезагрузки: reboot с задержкой.
			system("(sleep 3; reboot) >/dev/null 2>&1 &");
			return { status: "success", result: { scheduled: true, delay_seconds: 3 } };
		}
		if (op == "dns_benchmark") {
			let res = dns_benchmark.handle(util.as_string(args.mode));
			if (!res.ok)
				return { status: "failed", error: { code: "dns_benchmark_failed", message: util.as_string(res.error) } };
			return { status: "success", result: res };
		}
		if (op == "reload") {
			let res = ops.reload(product);
			if (!res.ok) return { status: "failed", error: { code: "reload_failed", message: res.error } };
			return { status: "success", result: { ok: true } };
		}
		if (op == "apply_uci") {
			let res = ops.apply_uci(
				product,
				args.items || [],
				args.base_state_hash || "",
				args.create_sections || [],
				args.local_lists || []
			);
			if (!res.ok) return { status: "failed", error: { code: res.code || "apply_failed", message: res.error } };
			return { status: "success", result: res };
		}
		if (op == "restore_section_options") {
			let res = ops.restore_section_options(product, args);
			if (!res.ok) return { status: "failed", error: { code: "restore_options_failed", message: res.error } };
			return { status: "success", result: res };
		}
		if (op == "apply_connections") {
			let res = ops.apply_connections(product, args);
			if (!res.ok) return { status: "failed", error: { code: "connections_failed", message: res.error } };
			return { status: "success", result: res };
		}
		if (op == "list_connections") {
			let res = ops.list_connections(product, args);
			if (!res.ok) return { status: "failed", error: { code: "list_connections_failed", message: res.error } };
			return { status: "success", result: res };
		}
		if (op == "manage_connection") {
			let res = ops.manage_connection(product, args);
			if (!res.ok) return { status: "failed", error: { code: "manage_connection_failed", message: res.error } };
			return { status: "success", result: res };
		}
		if (op == "delete_section") {
			let res = ops.delete_section(product, args);
			if (!res.ok) return { status: "failed", error: { code: "delete_section_failed", message: res.error } };
			return { status: "success", result: res };
		}
		if (op == "set_podkop_outbound") {
			let res = ops.set_podkop_outbound(product, args);
			if (!res.ok) return { status: "failed", error: { code: "podkop_outbound_failed", message: res.error } };
			return { status: "success", result: res };
		}
		if (op == "select_proxy") {
			let res = ops.select_proxy(product, args);
			if (!res.ok) return { status: "failed", error: { code: "select_proxy_failed", message: res.error } };
			return { status: "success", result: res };
		}
		if (op == "product_switch") {
			let target = util.as_string(args.product);
			let version = util.as_string(args.version);
			if (target != "tachyon" && target != "forkop" && target != "podkop" && target != "prokop")
				return { status: "failed", error: { code: "unsupported_product_switch", message: "Переключение на " + target + " пока не поддерживается" } };
			if (version != "" && match(version, /^[0-9]+([.][0-9]+){2,3}$/) == null)
				return { status: "failed", error: { code: "invalid_product_version", message: "Некорректная версия продукта" } };
			let current = platform.detect_product();
			let captured = { ok: true, sections: 0, subscriptions: 0, links: 0 };
			if (current != "unknown" && current != "conflict") {
				captured = ops.capture_product_config(current, target);
			} else if (current == "conflict") {
				// Конфликт: пробуем сохранить настройки хотя бы одного
				// продукта, кроме целевого, чтобы не потерять секции и подписки.
				let found = platform.installed_products(true);
				for (let item in found) {
					if (item.product == target)
						continue;
					let candidate = ops.capture_product_config(item.product, target);
					if (candidate.ok && (int(candidate.sections) > 0 || int(candidate.subscriptions) > 0 || int(candidate.links) > 0)) {
						captured = candidate;
						break;
					}
				}
			}
			let before = platform.installed_products(true);
			let command = "";
			if (target == "tachyon") {
				// Один роутер — один продукт: Tachyon не знает Prokop,
				// поэтому его пакеты и ядро убираем до установки.
				command = "if command -v opkg >/dev/null 2>&1; then /etc/init.d/prokop stop >/dev/null 2>&1 || true; /etc/init.d/podkop stop >/dev/null 2>&1 || true; /etc/init.d/forkop stop >/dev/null 2>&1 || true; opkg remove --force-depends prokop luci-app-prokop luci-i18n-prokop-ru podkop luci-app-podkop forkop luci-app-forkop luci-i18n-forkop-ru sing-box-forkop sing-box sing-box-tiny >/dev/null 2>&1 || true; fi; ";
				command += "if command -v apk >/dev/null 2>&1; then apk del prokop luci-app-prokop luci-i18n-prokop-ru podkop luci-app-podkop forkop luci-app-forkop luci-i18n-forkop-ru sing-box-forkop sing-box sing-box-tiny >/dev/null 2>&1 || true; fi; ";
				// Если пакетный менеджер не смог удалить продукт, убираем
				// оставшиеся бинарники/init-скрипты/конфиги, иначе detect_product
				// снова увидит конфликт.
				command += "rm -f /etc/init.d/prokop /etc/init.d/podkop /etc/init.d/forkop /usr/bin/prokop /usr/bin/podkop /usr/bin/forkop; ";
				command += "rm -rf /etc/config/prokop /etc/config/podkop /etc/config/forkop /usr/lib/prokop /usr/lib/podkop /usr/lib/forkop /usr/share/prokop /usr/share/podkop /usr/share/forkop; ";
				command += "wget -O /tmp/tachyon-setup.sh https://raw.githubusercontent.com/Dushnilin/tachyon/main/install.sh && sh /tmp/tachyon-setup.sh -y --tachyon-core";
				if (version != "")
					command += " --tag " + version;
			} else {
				if (current == "tachyon")
					command += "wget -O /tmp/tachyon-uninstall.sh https://raw.githubusercontent.com/Dushnilin/tachyon/main/uninstall.sh && sh /tmp/tachyon-uninstall.sh -y; ";
				if (target == "podkop") {
					command += "if command -v opkg >/dev/null 2>&1; then opkg remove --force-depends prokop luci-app-prokop luci-i18n-prokop-ru sing-box-forkop tachyon-core luci-i18n-forkop-ru >/dev/null 2>&1 || true; fi; ";
					command += "if command -v apk >/dev/null 2>&1; then apk del prokop luci-app-prokop luci-i18n-prokop-ru sing-box-forkop tachyon-core luci-i18n-forkop-ru >/dev/null 2>&1 || true; fi; ";
					command += "PODKOP_INSTALLER=\"$(wget -qO- https://raw.githubusercontent.com/itdoginfo/podkop/main/install.sh)\" && echo n | sh -c \"$PODKOP_INSTALLER\"; ";
					command += "if ! command -v sing-box >/dev/null 2>&1; then if command -v apk >/dev/null 2>&1; then apk update >/dev/null 2>&1; apk add sing-box >/dev/null 2>&1 || apk add sing-box-tiny >/dev/null 2>&1 || true; else opkg update >/dev/null 2>&1; opkg install sing-box >/dev/null 2>&1 || opkg install sing-box-tiny >/dev/null 2>&1 || true; fi; fi";
				} else if (target == "prokop") {
					// Prokop — переименованный Forkop: свой установщик сам
					// переносит старый Forkop. Podkop и Tachyon он не знает,
					// поэтому их пакеты удаляем заранее.
					command += "if command -v opkg >/dev/null 2>&1; then opkg remove --force-depends podkop luci-app-podkop tachyon-core >/dev/null 2>&1 || true; fi; ";
					command += "if command -v apk >/dev/null 2>&1; then apk del podkop luci-app-podkop tachyon-core >/dev/null 2>&1 || true; fi; ";
					// Остатки Tachyon занимают место, которого не хватает
					// установщику sing-box на роутерах с малым overlay.
					command += "rm -rf /etc/tachyon /etc/tachyon-core /etc/config/tachyon /etc/config/tachyon-core /usr/share/tachyon-core /usr/lib/tachyon /usr/lib/tachyon-core; ";
					// Ставим sing-box заранее: Prokop сохраняет уже
					// установленный вариант и не упирается в свой расчёт места.
					command += "if ! command -v sing-box >/dev/null 2>&1; then if command -v opkg >/dev/null 2>&1; then opkg update >/dev/null 2>&1; opkg install --force-space sing-box-tiny >/dev/null 2>&1 || opkg install --force-space sing-box >/dev/null 2>&1 || true; else apk update >/dev/null 2>&1; apk add sing-box-tiny >/dev/null 2>&1 || apk add sing-box >/dev/null 2>&1 || true; fi; fi; ";
					// Prokop сам управляет sing-box; отдельный автозапуск
					// от Podkop нужно погасить, иначе старт будет отклонён.
					command += "/etc/init.d/sing-box stop >/dev/null 2>&1 || true; /etc/init.d/sing-box disable >/dev/null 2>&1 || true; ubus call service delete '{ \"name\": \"sing-box\" }' >/dev/null 2>&1 || true; ";
					// Снимаем зависший guard от неудавшегося restore:
					// иначе Prokop навсегда показывает health = error.
					command += "nft delete table inet ProkopConfigRestoreDpiGuard >/dev/null 2>&1 || true; ";
					command += "wget -qO- https://asofwar.github.io/prokop/install.sh | sh -s -- --lang ru --confirm-legacy-migration";
				} else {
					// Forkop не умеет удалять Podkop/Prokop, делаем это сами.
					command += "if command -v opkg >/dev/null 2>&1; then opkg remove --force-depends prokop luci-app-prokop luci-i18n-prokop-ru podkop luci-app-podkop tachyon-core >/dev/null 2>&1 || true; fi; ";
					command += "if command -v apk >/dev/null 2>&1; then apk del prokop luci-app-prokop luci-i18n-prokop-ru podkop luci-app-podkop tachyon-core >/dev/null 2>&1 || true; fi; ";
					command += "wget -qO- https://raw.githubusercontent.com/ushan0v/forkop/main/install.sh | sh -s";
				}
			}
			let res = runner.run([ "sh", "-c", command ], 1800);
			let applied_migration = { ok: true, applied: 0, subscriptions: 0, links: 0, warnings: [] };
			if (captured.ok && int(captured.sections) > 0)
				applied_migration = ops.apply_product_config(target);
			if (target == "tachyon") {
				let cleanup = ops.cleanup_json_outbounds("tachyon");
				if (cleanup.ok && cleanup.removed > 0)
					runner.run_product("tachyon", [ "reload" ], 120);
				// После установки Tachyon асинхронно обновляет списки и в это
				// время может падать на ещё не собранных ruleset. Ждём
				// завершения обновления и затем гарантированно стартуем.
				let settle = "sleep 10; i=0; while [ $i -lt 40 ]; do tachyon list_update_status 2>/dev/null | grep -q '\"running\": true' || break; i=$((i+1)); sleep 3; done; tachyon start >/dev/null 2>&1 || true; i=0; while [ $i -lt 20 ]; do tachyon get_status 2>/dev/null | grep -q '\"running\": 1' && break; i=$((i+1)); sleep 2; done";
				runner.run([ "sh", "-c", settle ], 190);
			}
			let detected = platform.detect_product();
			if (detected != target && !res.ok)
				return { status: "failed", error: { code: "product_switch_failed", message: runner.error_text(res) } };
			if (detected != target)
				return { status: "failed", error: { code: "product_switch_verify_failed", message: "после установки " + target + " не обнаружен" } };
			let detected_version = platform.product_version(target);
			let after = platform.installed_products(true);
			let removed = [];
			for (let item in before) {
				let still = false;
				for (let now_item in after) {
					if (now_item.product == item.product)
						still = true;
				}
				if (!still)
					push(removed, item.product);
			}
			runner.run([ "sh", "-c", "(sleep 3; /etc/init.d/routx-agent restart) >/dev/null 2>&1 &" ], 5);
			return { status: "success", result: {
				product: detected,
				requested: target,
				version: detected_version,
				requested_version: version,
				removed_products: removed,
				installed_products: after,
				migration: applied_migration,
				install_output: util.truncate_text(util.mask_secrets(runner.error_text(res)), 2000)
			} };
		}
		if (op == "remove_packages") {
			let current = platform.detect_product();
			let packages = [];
			for (let raw in (args.packages || [])) {
				let name = util.as_string(raw);
				let owner = platform.package_product(name);
				if (owner == "")
					return { status: "failed", error: { code: "invalid_package", message: "неизвестный пакет: " + name } };
				if (current != "conflict" && owner == current)
					return { status: "failed", error: { code: "cannot_remove_active_product", message: "нельзя удалить пакет активного продукта: " + name } };
				push(packages, name);
			}
			packages = util.dedupe(packages);
			if (length(packages) == 0)
				return { status: "failed", error: { code: "no_packages", message: "не выбрано ни одного пакета" } };
			let joined = join(" ", packages);
			let command = "if command -v opkg >/dev/null 2>&1; then opkg remove --force-depends " + joined + "; elif command -v apk >/dev/null 2>&1; then apk del " + joined + "; else exit 127; fi";
			let res = runner.run([ "sh", "-c", command ], 300);
			let after = platform.installed_products(true);
			if (!res.ok)
				return { status: "failed", error: { code: "remove_packages_failed", message: runner.error_text(res) } };
			return { status: "success", result: {
				packages: packages,
				installed_products: after,
				output: util.truncate_text(util.mask_secrets(runner.error_text(res)), 1000)
			} };
		}
		if (op == "sb_check_update") {
			let res = runner.run_product(product, [ "component_action", "sing_box", "check_update" ], 120);
			let parsed = util.json_parse(res.stdout);
			if (!res.ok || type(parsed) != "object")
				return { status: "failed", error: { code: "sb_check_failed", message: runner.error_text(res) } };
			let sb = platform.sing_box_info(product);
			return { status: "success", result: {
				current_version: util.as_string(parsed.current_version),
				latest_version: util.as_string(parsed.latest_version),
				status: util.as_string(parsed.status),
				release_url: util.as_string(parsed.release_url),
				message: util.as_string(parsed.message),
				variant: sb.variant,
				version: sb.version
			} };
		}
		if (op == "sb_install") {
			let variant = util.as_string(args.variant);
			let version = util.as_string(args.version_tag);
			if (version == "" && args.version != null)
				version = util.as_string(args.version);
			let action = "";
			if (variant == "tiny")
				action = "install_tiny";
			else if (variant == "extended")
				action = version != "" ? "install_version" : "install_extended";
			else if (variant == "extended_compressed" || variant == "extended-compressed")
				action = "install_extended_compressed";
			else if (variant == "stable" || variant == "standard")
				action = "install_stable";
			else if (variant == "" && version != "")
				action = "install_version";
			else if (variant == "")
				action = "install";
			else
				return { status: "failed", error: { code: "invalid_variant", message: "неизвестный вариант sing-box: " + variant } };

			let argv = [ "component_action", "sing_box", action ];
			if (action == "install_version")
				push(argv, version);

			let res = runner.run_product(product, argv, 600);
			let parsed = util.json_parse(res.stdout);
			if (!res.ok)
				return { status: "failed", error: { code: "sb_install_failed", message: runner.error_text(res) } };
			if (type(parsed) == "object" && parsed.success === false) {
				let message = util.as_string(parsed.message);
				if (message == "")
					message = util.as_string(parsed.reason);
				return { status: "failed", error: { code: "sb_install_failed", message: message == "" ? "установка не удалась" : message } };
			}
			let sb = platform.sing_box_info(product);
			if (sb.version == "")
				return { status: "failed", error: { code: "sb_install_verify_failed", message: "после установки версия sing-box не определена" } };
			return { status: "success", result: {
				version: sb.version,
				variant: sb.variant,
				action: action,
				upstream: parsed
			} };
		}
		if (op == "snapshot_create") {
			let res = snaps.snapshot_create(product, args.reason || "manual");
			if (!res.ok) return { status: "failed", error: { code: "snapshot_failed", message: res.error } };
			return { status: "success", result: res };
		}
		if (op == "snapshot_list") {
			let res = snaps.snapshot_list(product);
			if (!res.ok) return { status: "failed", error: { code: "snapshot_list_failed", message: res.error } };
			return { status: "success", result: res };
		}
		if (op == "snapshot_restore") {
			let res = snaps.snapshot_restore(product, args.snapshot || args.external_id, args.kind || "local");
			if (!res.ok) return { status: "failed", error: { code: "restore_failed", message: res.error } };
			return { status: "success", result: res };
		}
		if (op == "diagnostics_quick") {
			let d = diag.diagnostics_quick(product);
			return { status: "success", result: d };
		}
		if (op == "diagnostics_full") {
			let d = diag.diagnostics_full(product);
			return { status: "success", result: d };
		}
		if (op == "monitor_probe") {
			let result = monitor.probe(product, util.is_true(args.force));
			let sb = platform.sing_box_info(product);
			result.sing_box_version = sb.version;
			result.agent_version = client.VERSION;
			return { status: "success", result: result };
		}
		if (op == "self_update") {
			let result = self_update.handle(product, args);
			if (!result.ok)
				return { status: "failed", error: {
					code: util.as_string(result.error) || "self_update_failed",
					message: util.as_string(result.message) || "Не удалось обновить агента"
				} };
			return { status: "success", result: result };
		}
		if (op == "site_probe") {
			let result = monitor.site_probe(product, args.targets);
			if (!result.ok)
				return { status: "failed", error: {
					code: util.as_string(result.error) || "site_probe_failed",
					message: util.as_string(result.message) || "Не удалось проверить сайты"
				} };
			return { status: "success", result: result };
		}
		if (op == "access_check") {
			let result = monitor.access_check(product, util.as_string(args.target));
			if (result.ok !== true)
				return { status: "failed", error: {
					code: util.as_string(result.error) || "access_failed",
					message: util.as_string(result.message) || "Запрос через прокси не прошёл"
				} };
			return { status: "success", result: result };
		}
		if (op == "logs_tail") {
			return { status: "success", result: { lines: [], available: false } };
		}

		return { status: "failed", error: { code: "unknown_op", message: "неподдерживаемая операция: " + op } };
	}
	catch (e) {
		return { status: "failed", error: { code: "exception", message: util.truncate_text(util.as_string(e), 200) } };
	}
}

// Статичные поля (версия продукта, модель, OpenWrt) не меняются, а
// sing_box_info() запускает CLI продукта. Кэш не даёт дёргать его на каждом
// длинном опросе (status.json пишется после каждого poll).
let static_cache = null;
let sing_box_cache = { at: -1000, version: "", variant: "" };

function invalidate_info_cache() {
	static_cache = null;
	sing_box_cache.at = -1000;
}

function static_info(product) {
	if (static_cache != null && static_cache.product == product)
		return static_cache;
	static_cache = {
		product: product,
		version: platform.product_version(product),
		openwrt: platform.openwrt_version(),
		model: platform.model(),
		arch: platform.arch()
	};
	return static_cache;
}

function sing_box_info_cached(product) {
	let now = util.now_epoch();
	if (now - sing_box_cache.at > 60) {
		let sb = platform.sing_box_info(product);
		sing_box_cache = { at: now, version: sb.version, variant: sb.variant };
	}
	return sing_box_cache;
}

function write_status(cfg, product, extra) {
	extra = type(extra) == "object" ? extra : {};
	let info = static_info(product);
	let sb = sing_box_info_cached(product);
	let data = {
		enabled: cfg.enabled,
		bound: cfg.bound,
		server: cfg.server,
		router_id: cfg.router_id,
		product: product,
		product_version: info.version,
		openwrt: info.openwrt,
		model: info.model,
		arch: info.arch,
		agent_version: client.VERSION,
		sing_box_version: sb.version,
		sing_box_variant: sb.variant,
		last_poll_at: util.as_string(extra.poll_at),
		last_error: util.as_string(extra.error),
		updated_at: util.iso_now()
	};
	util.mkdir_p(util.RUN_DIR, 0700);
	util.write_atomic(util.RUN_DIR + "/status.json", util.json_string(data) + "\n", 0644);
}

function run() {
	util.mkdir_p(util.RUN_DIR, 0700);
	util.mkdir_p(util.STATE_DIR, 0700);

	let cfg = config.load();
	if (!cfg.enabled) {
		write_status(cfg, "unknown", { error: "агент отключён" });
		warn("RoutX disabled\n");
		return 0;
	}

	let product = platform.detect_product();
	if (product == "conflict") {
		warn("product_conflict: оба Forkop и Prokop обнаружены\n");
		write_status(cfg, product, { error: "product_conflict" });
		return 1;
	}

	// Старые конфиги Forkop после смены продукта могут содержать
	// subscription_url. Tachyon понимает только outbound_source, поэтому
	// переносим подписку, иначе прокси-группа не создаётся.
	if (product == "tachyon") {
		let migrated = ops.migrate_legacy_tachyon_subscriptions();
		if (!migrated.ok)
			warn("tachyon legacy subscription migration: " + util.as_string(migrated.error) + "\n");
		else if (int(migrated.migrated) > 0)
			warn("tachyon legacy subscriptions migrated: " + migrated.migrated + "\n");
		let lists = ops.migrate_tachyon_lists();
		if (!lists.ok)
			warn("tachyon list migration: " + util.as_string(lists.error) + "\n");
		else if (int(lists.changed) > 0)
			warn("tachyon rule_set lists migrated: " + lists.changed + "\n");
	}

	// Если агент перезапустился посреди смены продукта, применяем
	// сохранённую миграцию секций и источников.
	if (product != "unknown" && product != "conflict") {
		let pending = ops.apply_product_config(product);
		if (pending.ok && int(pending.applied) > 0)
			warn("pending product migration applied: " + pending.applied + " sections\n");
	}
	if (product == "tachyon") {
		let upd = runner.run_product("tachyon", [ "subscription_update_if_due" ], 180);
		if (!upd.ok)
			warn("tachyon subscription update: " + runner.error_text(upd) + "\n");
	}

	write_status(cfg, product);

	let bind_error = "";
	if (cfg.bind_pending && !cfg.bound) {
		let br = client.bind(product);
		if (br.ok) {
			cfg = config.load();
			// Сразу фиксируем успешную привязку: иначе установщик и LuCI
			// видят старый status.json до конца первого длинного опроса.
			write_status(cfg, product);
		} else {
			bind_error = util.as_string(br.error);
		}
	}

	if (cfg.bound) {
		client.probe(product);
	}

	let backoff = 5;
	while (true) {
		cfg = config.load();
		if (!cfg.enabled)
			break;
		if (!cfg.bound) {
			if (cfg.bind_pending) {
				let br = client.bind(product);
				if (br.ok) {
					cfg = config.load();
					bind_error = "";
					write_status(cfg, product);
					continue;
				}
				bind_error = util.as_string(br.error);
			}
			write_status(cfg, product, {
				error: bind_error != "" ? ("привязка: " + bind_error) : "ожидает привязки"
			});
			sleep(backoff * 1000);
			backoff = backoff < 60 ? backoff * 2 : 60;
			continue;
		}
		backoff = 5;

		let poll = client.poll(product);
		write_status(cfg, product, {
			poll_at: util.iso_now(),
			error: poll.unauth ? "токен отклонён" : (poll.ok ? "" : "нет связи с сервером")
		});
		if (poll.unauth) {
			sleep(5000);
			continue;
		}
		if (poll.command) {
			let cmd = poll.command;
			let h = handle_command(cmd);
			client.result(cmd.id, h.status, h.result, h.error);
			invalidate_info_cache();
			write_status(cfg, product, { poll_at: util.iso_now() });
			continue;
		}
		sleep(1000);
	}
	write_status(cfg, product, { error: "агент остановлен" });
	return 0;
}

return { run, handle_command };

