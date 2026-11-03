// RoutX: операции apply/precheck/reload/service/verify
const fs = require("fs");
const uci = require("uci");
const util = require("jn_util");
const allow = require("jn_allowlist");
const run = require("jn_run");
const state = require("jn_uci_state");

/**
 * Prokop не может собрать конфигурацию, если не осталось ни одной включённой
 * секции. Перед выключением последней проверяем, есть ли другая включённая.
 * Функции объявлены до apply_uci/manage_connection: ucode не поднимает
 * объявления снизу вверх для уже скомпилированных функций.
 */
function has_other_enabled_section(product, cursor, section) {
	let all = cursor.get_all(product);
	if (type(all) != "object")
		return false;
	for (let sname in all) {
		let sect = all[sname];
		if (type(sect) != "object" || sect[".type"] != "section")
			continue;
		let real = sect[".name"] == null ? sname : util.as_string(sect[".name"]);
		if (real == section || sname == section)
			continue;
		if (util.as_string(sect.enabled) != "0")
			return true;
	}
	return false;
}

function last_enabled_error() {
	return {
		ok: false,
		code: "last_enabled_rule",
		error: "нельзя выключить последнее включённое правило: Prokop не сможет собрать конфигурацию. Сначала включите другое правило"
	};
}

function precheck(product) {
	let rs = state.build_read_state(product);
	return { ok: true, managed_count: length(keys(rs.managed)), health: rs.health.overall };
}

function verify(product) {
	let sb = require("jn_platform").sing_box_info(product);
	return { ok: sb.version != "", version: sb.version, variant: sb.variant };
}

function service_action(product, action) {
	if (action != "restart" && action != "start" && action != "stop" &&
	    action != "enable" && action != "disable")
		return { ok: false, error: "недопустимое действие" };

	if (action == "enable" || action == "disable") {
		let res = run.run_product(product, [ action ], 60);
		if (!res.ok) {
			let init = run.run_init(product, action, 60);
			if (!init.ok)
				return { ok: false, error: run.error_text(res) };
		}

		// Prokop/Forkop сами управляют sing-box и при каждом старте/перезагрузке
		// намеренно отключают отдельный автозапуск /etc/init.d/sing-box.
		// Включать его обратно нельзя: продукт всё равно снимет symlink, а гонка
		// на загрузке может запустить sing-box без готовой конфигурации.
		// При выключении продукта отдельный автозапуск sing-box тоже выключаем,
		// чтобы после перезагрузки не осталась «сиротская» служба.
		let sing_box = "managed_by_product";
		if (action == "disable" && fs.stat("/etc/init.d/sing-box") != null) {
			let sb = run.run_init("sing-box", "disable", 60);
			if (!sb.ok)
				sing_box = "disable_failed";
		}
		return { ok: true, action: action, product: action, sing_box: sing_box };
	}

	let res = run.run_init(product, action, 90);
	if (!res.ok)
		return { ok: false, error: run.error_text(res) };
	return { ok: true, action: action };
}

function podkop_config_path() {
	let cursor = uci.cursor();
	let path = util.as_string(cursor.get("podkop", "settings", "config_path"));
	return path == "" ? "/etc/sing-box/config.json" : path;
}

function podkop_has_enabled_section() {
	let cursor = uci.cursor();
	let all = cursor.get_all("podkop");
	if (type(all) != "object")
		return false;
	for (let sname in all) {
		let sect = all[sname];
		if (type(sect) != "object" || sect[".type"] != "section")
			continue;
		if (util.as_string(sect.enabled) == "0")
			continue;
		let kind = util.as_string(sect.connection_type);
		if (kind == "proxy" || kind == "vpn")
			return true;
	}
	return false;
}

function podkop_log_tail() {
	let res = run.run([ "logread", "-e", "podkop" ], 10);
	if (!res.ok)
		return "";
	let lines = [];
	for (let line in split(res.stdout, "\n")) {
		let text = trim(line);
		if (text != "")
			push(lines, text);
	}
	let start = length(lines) > 6 ? length(lines) - 6 : 0;
	let tail = [];
	for (let i = start; i < length(lines); i++)
		push(tail, lines[i]);
	return util.truncate_text(util.mask_secrets(join(" | ", tail)), 900);
}

// Проверка результата reload для Podkop: конфиг sing-box должен проходить
// `sing-box check`, а служба — реально работать. Иначе сервер откатит снимок.
function podkop_reload_check() {
	let path = podkop_config_path();
	let tail = "";
	if (util.file_exists(path)) {
		let check = run.run([ "sing-box", "check", "-c", path ], 60);
		if (!check.ok) {
			tail = podkop_log_tail();
			return { ok: false, error: "sing_box_check_failed: " + run.error_text(check) +
				(tail != "" ? " | " + tail : "") };
		}
	} else if (podkop_has_enabled_section()) {
		return { ok: false, error: "sing_box_config_missing: " + path };
	}
	if (podkop_has_enabled_section()) {
		let status = run.run_product("podkop", [ "get_sing_box_status" ], 20);
		if (!status.ok) {
			tail = podkop_log_tail();
			return { ok: false, error: "sing_box_status_failed: " + run.error_text(status) +
				(tail != "" ? " | " + tail : "") };
		}
		let parsed = util.json_parse(status.stdout);
		if (type(parsed) != "object" || int(parsed.running) != 1) {
			tail = podkop_log_tail();
			return { ok: false, error: "sing_box_not_running" + (tail != "" ? ": " + tail : "") };
		}
	}
	return { ok: true };
}

function reload(product) {
	if (product == "podkop") {
		let res = run.run_product("podkop", ["reload"], 120);
		let check = podkop_reload_check();
		if (res.ok && check.ok)
			return { ok: true };

		// Podkop обновляет community-списки в фоне. Если sing-box не стартовал
		// из-за ещё не скачанных rule-set, ждём обновление и повторяем.
		let transient = !check.ok &&
			(match(check.error, /no such file|rule-set|not found/i) != null ||
			 check.error == "sing_box_not_running");
		if (transient || (res.ok && !check.ok)) {
			for (let i = 0; i < 24; i++) {
				sleep(5000);
				let next = podkop_reload_check();
				if (next.ok) {
					if (res.ok)
						return { ok: true };
					res = run.run_product("podkop", ["reload"], 120);
					let after = podkop_reload_check();
					if (res.ok && after.ok)
						return { ok: true };
					check = after;
				} else {
					check = next;
				}
			}
		}
		if (!check.ok)
			return check;
		let tail = podkop_log_tail();
		return { ok: false, error: run.error_text(res) + (tail != "" ? " | " + tail : "") };
	}

	// Для Prokop/Forkop сначала используем штатный CLI: init-скрипт может
	// запускать reload асинхронно и оставлять lock, из-за чего второй вызов
	// получает «existing» и ненулевой код.
	let res = run.run_product(product, ["reload"], 90);
	if (res.ok)
		return { ok: true };
	let init = run.run_init(product, "reload", 90);
	if (init.ok)
		return { ok: true };
	return { ok: false, error: run.error_text(res) };
}

function apply_uci(product, items, base_state_hash, create_sections, local_lists) {
	if (product != "forkop" && product != "prokop" && product != "podkop")
		return { ok: false, error: "неизвестный продукт" };

	let current = state.read_state(product);
	if (util.as_string(base_state_hash) != "" && current.state_hash != util.as_string(base_state_hash)) {
		return { ok: false, error: "base_state_hash_mismatch", code: "base_state_hash_mismatch" };
	}

	let create = {};
	for (let name in (create_sections || []))
		create[util.as_string(name)] = true;

	let list_prefix = "/etc/routx-agent/lists/";
	for (let list in (local_lists || [])) {
		let path = util.as_string(list.path);
		if (substr(path, 0, length(list_prefix)) != list_prefix ||
		    match(path, /^[A-Za-z0-9_.\/-]+\.lst$/) == null)
			return { ok: false, error: "invalid_local_list_path:" + path };
		let entries = list.entries;
		if (type(entries) != "array")
			return { ok: false, error: "invalid_local_list_entries:" + path };
		let lines = [];
		for (let raw in entries) {
			let value = trim(util.as_string(raw));
			if (value == "")
				continue;
			if (match(value, /^[A-Za-z0-9:._\/\*-]+$/) == null)
				return { ok: false, error: "invalid_local_list_entry:" + path };
			push(lines, value);
			if (length(lines) > 5000)
				return { ok: false, error: "local_list_too_large:" + path };
		}
		util.mkdir_p(util.dirname(path), 0700);
		if (!util.write_atomic(path, join("\n", lines) + (length(lines) > 0 ? "\n" : ""), 0600))
			return { ok: false, error: "local_list_write_failed:" + path };
	}

	let cursor = uci.cursor();

	// Не даём выключить последнее включённое правило: Prokop не сможет
	// собрать конфигурацию. Сначала пользователь должен включить другое.
	let disabling = {};
	for (let item in items) {
		let path = util.as_string(item.path);
		let m = match(path, /^section\.([A-Za-z0-9_.-]{1,64})\.enabled$/);
		if (m == null)
			continue;
		let value = item.value;
		if (value == null && item.after != null)
			value = item.after;
		if (util.as_string(value) == "0")
			disabling[m[1]] = true;
	}
	// Podkop допускает конфигурацию без активных секций, остальным продуктам
	// нельзя оставить ноль включённых правил.
	if (product != "podkop") {
	for (let section in disabling) {
		if (!has_other_enabled_section(product, cursor, section))
			return last_enabled_error();
	}
	}

	let applied = [];
	for (let item in items) {
		let path = util.as_string(item.path);
		// Сервер присылает diff-элементы с after; прямые вызовы — с value.
		let value = item.value;
		if (value == null && item.after != null)
			value = item.after;
		let parsed = allow.parse_path(path);
		if (parsed == null)
			return { ok: false, error: "invalid_path:" + path };
		let rule = allow.classify_path(path);
		if (!rule.allowed)
			return { ok: false, error: "path_not_allowed:" + path };

		let norm = allow.normalize_value(value, rule.list);
		if (norm.ok === false)
			return { ok: false, error: "normalize_failed:" + path };

		if (parsed.type == "settings") {
			if (norm.value == null) {
				cursor.delete(product, "settings", parsed.option);
			} else if (rule.list) {
				cursor.delete(product, "settings", parsed.option);
				cursor.set(product, "settings", parsed.option, norm.value);
			} else {
				cursor.set(product, "settings", parsed.option, norm.value);
			}
			push(applied, path);
			continue;
		}

		let secname = parsed.section;
		if (cursor.get(product, secname) == null) {
			if (parsed.type == "urltest") {
				cursor.set(product, secname, "urltest");
			} else if (parsed.type == "section" && create[secname]) {
				cursor.set(product, secname, "section");
			} else {
				return { ok: false, error: "missing_section:" + secname, code: "missing_entity" };
			}
		}

		if (norm.value == null) {
			cursor.delete(product, secname, parsed.option);
		} else if (rule.list) {
			cursor.delete(product, secname, parsed.option);
			cursor.set(product, secname, parsed.option, norm.value);
		} else {
			cursor.set(product, secname, parsed.option, norm.value);
		}
		push(applied, path);
	}

	if (cursor.commit(product) == null)
		return { ok: false, error: "uci commit failed" };
	return { ok: true, applied: applied };
}

const LINK_RE = /^(vless|vmess|trojan|ss|ssr|hysteria|hysteria2|hy2|tuic|anytls|socks|socks4|socks4a|socks5|socks5h):\/\/\S+$/i;
const SUBSCRIPTION_RE = /^https?:\/\/\S+$/i;
const SECTION_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const CONNECTIONS_STATE = util.STATE_DIR + "/connections.json";

// Какие VLESS-ссылки в секции добавил RoutX. Нужно, чтобы при
// повторном применении не стирать ссылки, добавленные пользователем вручную.
function load_link_state() {
	let parsed = util.json_parse(util.read_file(CONNECTIONS_STATE, ""));
	return type(parsed) == "object" ? parsed : {};
}

function save_link_state(link_state) {
	util.mkdir_p(util.STATE_DIR, 0700);
	return util.write_atomic(CONNECTIONS_STATE, util.canonical_json(link_state) + "\n", 0600);
}

function managed_link_hashes(link_state, product, section) {
	let entry = link_state[product + ":" + section];
	return type(entry) == "array" ? entry : [];
}

function connection_mask(url) {
	let text = util.as_string(url);
	let sep = index(text, "://");
	let scheme = sep > 0 ? substr(text, 0, sep) : "";
	let rest = sep > 0 ? substr(text, sep + 3) : text;
	let stop = length(rest);
	for (let ch in [ "/", "?", "#" ]) {
		let pos = index(rest, ch);
		if (pos >= 0 && pos < stop)
			stop = pos;
	}
	let host = substr(rest, 0, stop);
	let at = rindex(host, "@");
	if (at >= 0)
		host = substr(host, at + 1);
	let tail = length(text) > 4 ? substr(text, length(text) - 4) : "";
	return { scheme: scheme, host: host, tail: tail };
}

function list_connections(product, args) {
	if (product != "forkop" && product != "prokop" && product != "podkop")
		return { ok: false, error: "неизвестный продукт" };
	let section = util.as_string(args.section);
	if (match(section, SECTION_RE) == null)
		return { ok: false, error: "invalid_section" };

	let cursor = uci.cursor();
	if (cursor.get(product, section) != "section")
		return { ok: false, error: "section_missing" };

	let all = cursor.get_all(product);
	if (type(all) != "object")
		all = {};
	let subscriptions = [];
	if (product != "podkop") {
		for (let sname in all) {
			let sect = all[sname];
			if (type(sect) != "object" || sect[".type"] != "subscription_url")
				continue;
			if (util.as_string(sect.section) != section)
				continue;
			let info = connection_mask(sect.url);
			push(subscriptions, { name: sname, host: info.host, tail: info.tail });
		}
	}

	let links = [];
	let raw = [];
	let link_keys = product == "podkop"
		? [ "urltest_proxy_links", "selector_proxy_links" ]
		: [ "selector_proxy_links" ];
	for (let key in link_keys) {
		let value = cursor.get(product, section, key);
		if (type(value) == "array") {
			for (let item in value)
				push(raw, item);
		} else if (value != null) {
			push(raw, value);
		}
	}
	if (product == "podkop") {
		let single = util.as_string(cursor.get(product, section, "proxy_string"));
		if (single != "")
			push(raw, single);
	}
	let index_value = 0;
	for (let item in raw) {
		let link = util.as_string(item);
		if (link == "") {
			index_value++;
			continue;
		}
		let info = connection_mask(link);
		let hash_pos = index(link, "#");
		let label = hash_pos >= 0 ? substr(link, hash_pos + 1) : "";
		push(links, {
			index: index_value,
			hash: util.sha256_hex(link),
			scheme: info.scheme,
			host: info.host,
			tail: info.tail,
			label: label
		});
		index_value++;
	}

	return { ok: true, section: section, subscriptions: subscriptions, links: links };
}

function podkop_proxy_mode(cursor, section) {
	let mode = util.as_string(cursor.get("podkop", section, "proxy_config_type"));
	if (mode == "selector" || mode == "urltest" || mode == "outbound")
		return mode;
	if (cursor.get("podkop", section, "outbound_json") != null)
		return "outbound";
	if (cursor.get("podkop", section, "urltest_proxy_links") != null)
		return "urltest";
	if (cursor.get("podkop", section, "selector_proxy_links") != null)
		return "selector";
	return "url";
}

function podkop_proxy_option(mode) {
	if (mode == "outbound")
		return "outbound_json";
	if (mode == "urltest")
		return "urltest_proxy_links";
	if (mode == "selector")
		return "selector_proxy_links";
	return "proxy_string";
}

function podkop_proxy_links(cursor, section, mode) {
	if (mode == "outbound")
		return [];
	if (mode == "url") {
		let raw = util.as_string(cursor.get("podkop", section, "proxy_string"));
		return raw == "" ? [] : [ raw ];
	}
	let raw = cursor.get("podkop", section, podkop_proxy_option(mode));
	if (type(raw) != "array")
		return raw == null ? [] : [ util.as_string(raw) ];
	return raw;
}

function podkop_write_links(cursor, section, mode, links) {
	cursor.delete("podkop", section, "proxy_string");
	cursor.delete("podkop", section, "selector_proxy_links");
	cursor.delete("podkop", section, "urltest_proxy_links");
	let option = podkop_proxy_option(mode);
	if (length(links) == 0)
		return;
	if (mode == "url")
		cursor.set("podkop", section, option, links[0]);
	else
		cursor.set("podkop", section, option, links);
}

function manage_podkop_connection(section, action, kind, value, args) {
	if (kind != "link")
		return { ok: false, error: "podkop_subscriptions_unsupported" };
	let cursor = uci.cursor();
	if (cursor.get("podkop", section) != "section")
		return { ok: false, error: "section_missing" };
	let mode = podkop_proxy_mode(cursor, section);
	if (mode == "outbound")
		return { ok: false, error: "podkop_outbound_managed_manually" };
	let links = podkop_proxy_links(cursor, section, mode);
	let hash = util.as_string(args.hash);
	if (match(hash, /^[a-f0-9]{64}$/) == null)
		return { ok: false, error: "invalid_hash" };
	let found = -1;
	for (let i = 0; i < length(links); i++)
		if (util.sha256_hex(util.as_string(links[i])) == hash) {
			found = i;
			break;
		}
	if (found < 0)
		return { ok: false, error: "link_missing" };

	let next = [];
	for (let i = 0; i < length(links); i++) {
		if (i == found) {
			if (action != "delete")
				push(next, value);
		} else {
			push(next, links[i]);
		}
	}
	podkop_write_links(cursor, section, mode, next);

	let disabled = false;
	if (action == "delete" && length(next) == 0) {
		cursor.set("podkop", section, "enabled", "0");
		disabled = true;
	}
	if (cursor.commit("podkop") == null)
		return { ok: false, error: "uci commit failed" };
	return { ok: true, section: section, action: action, kind: kind, disabled: disabled };
}

function manage_connection(product, args) {
	if (product != "forkop" && product != "prokop" && product != "podkop")
		return { ok: false, error: "неизвестный продукт" };
	let section = util.as_string(args.section);
	if (match(section, SECTION_RE) == null)
		return { ok: false, error: "invalid_section" };
	let action = util.as_string(args.action);
	if (action != "delete" && action != "replace")
		return { ok: false, error: "invalid_action" };
	let kind = util.as_string(args.kind);
	if (kind != "subscription" && kind != "link")
		return { ok: false, error: "invalid_kind" };

	let value = trim(util.as_string(args.value));
	if (action == "replace") {
		if (kind == "subscription") {
			if (match(value, SUBSCRIPTION_RE) == null)
				return { ok: false, error: "invalid_subscription" };
		} else if (match(value, LINK_RE) == null) {
			return { ok: false, error: "invalid_link" };
		}
	}

	if (product == "podkop")
		return manage_podkop_connection(section, action, kind, value, args);

	let cursor = uci.cursor();
	if (cursor.get(product, section) != "section")
		return { ok: false, error: "section_missing" };

	if (kind == "subscription") {
		let name = util.as_string(args.name);
		if (match(name, SECTION_RE) == null)
			return { ok: false, error: "invalid_name" };
		if (cursor.get(product, name) != "subscription_url")
			return { ok: false, error: "subscription_missing" };
		if (util.as_string(cursor.get(product, name, "section")) != section)
			return { ok: false, error: "subscription_section_mismatch" };
		if (action == "delete")
			cursor.delete(product, name);
		else
			cursor.set(product, name, "url", value);
	} else {
		let hash = util.as_string(args.hash);
		if (match(hash, /^[a-f0-9]{64}$/) == null)
			return { ok: false, error: "invalid_hash" };
		let raw = cursor.get(product, section, "selector_proxy_links");
		if (type(raw) != "array")
			raw = raw == null ? [] : [ raw ];
		let found = -1;
		for (let i = 0; i < length(raw); i++)
			if (util.sha256_hex(util.as_string(raw[i])) == hash) {
				found = i;
				break;
			}
		if (found < 0)
			return { ok: false, error: "link_missing" };
		if (action == "delete") {
			let next = [];
			for (let i = 0; i < length(raw); i++)
				if (i != found)
					push(next, raw[i]);
			if (length(next) == 0)
				cursor.delete(product, section, "selector_proxy_links");
			else
				cursor.set(product, section, "selector_proxy_links", next);
		} else {
			raw[found] = value;
			cursor.set(product, section, "selector_proxy_links", raw);
		}
	}

	// Если после удаления в секции не осталось источников подключения,
	// выключаем её, чтобы Prokop не ругался на connection без подключения.
	let disabled = false;
	if (action == "delete") {
		let subscriptions = 0;
		let all = cursor.get_all(product);
		if (type(all) != "object")
			all = {};
		for (let sname in all) {
			let sect = all[sname];
			if (type(sect) == "object" && sect[".type"] == "subscription_url" &&
			    util.as_string(sect.section) == section)
				subscriptions++;
		}
		let links = cursor.get(product, section, "selector_proxy_links");
		let link_count = type(links) == "array" ? length(links) : (links == null ? 0 : 1);
		let outbounds = cursor.get(product, section, "outbound_jsons");
		let outbound_count = type(outbounds) == "array" ? length(outbounds) : (outbounds == null ? 0 : 1);
		if (subscriptions + link_count + outbound_count == 0) {
			if (!has_other_enabled_section(product, cursor, section))
				return last_enabled_error();
			cursor.set(product, section, "enabled", "0");
			disabled = true;
		}
	}

	if (cursor.commit(product) == null)
		return { ok: false, error: "uci commit failed" };
	return { ok: true, section: section, action: action, kind: kind, disabled: disabled };
}

/**
 * Живое чтение всех правил: настройки секций, подписки, прямые ссылки
 * и содержимое локальных .lst. Один вызов вместо list_connections на каждую
 * секцию. Секреты по-прежнему не отдаются: только host/tail/hash.
 */
function read_rules(product) {
	if (product != "forkop" && product != "prokop" && product != "podkop")
		return { ok: false, error: "неизвестный продукт" };

	let rs = state.read_state(product);
	let managed = rs.managed;

	let names = {};
	for (let path in managed) {
		let m = match(path, /^section\.([A-Za-z0-9_.-]{1,64})\./);
		if (m != null)
			names[m[1]] = true;
	}

	let sections = [];
	for (let name in names) {
		let options = {};
		let prefix = "section." + name + ".";
		for (let path in managed) {
			if (substr(path, 0, length(prefix)) == prefix)
				options[substr(path, length(prefix))] = managed[path];
		}

		let conn = list_connections(product, { section: name });
		let lists = {};
		let paths = options.domain_ip_lists;
		if (type(paths) != "array")
			paths = paths == null ? [] : [ paths ];
		for (let item in paths) {
			let path = util.as_string(item);
			if (match(path, /^\/etc\/routx-agent\/lists\/[A-Za-z0-9_.\/-]+\.lst$/) == null)
				continue;
			let text = util.read_file(path, "");
			if (text == "")
				continue;
			let lines = [];
			for (let line in split(text, "\n")) {
				let value = trim(line);
				if (value != "")
					push(lines, value);
				if (length(lines) >= 5000)
					break;
			}
			lists[path] = lines;
		}

		push(sections, {
			section: name,
			options: options,
			subscriptions: conn.ok ? conn.subscriptions : [],
			links: conn.ok ? conn.links : [],
			lists: lists
		});
	}

	return {
		ok: true,
		state_hash: rs.state_hash,
		managed: managed,
		sections: sections
	};
}

function set_podkop_outbound(product, args) {
	if (product != "podkop")
		return { ok: false, error: "только для Podkop" };
	let section = util.as_string(args.section);
	if (match(section, SECTION_RE) == null)
		return { ok: false, error: "invalid_section" };
	let text = util.as_string(args.outbound_json);
	if (length(text) > 65535)
		return { ok: false, error: "outbound_json_too_large" };
	let parsed = util.json_parse(text);
	if (type(parsed) != "object" || type(parsed.type) != "string")
		return { ok: false, error: "invalid_outbound_json" };
	let kind = lc(util.as_string(parsed.type));
	let forbidden = { direct: true, block: true, dns: true, selector: true, urltest: true };
	if (forbidden[kind])
		return { ok: false, error: "outbound_type_not_allowed:" + kind };

	let cursor = uci.cursor();
	if (cursor.get("podkop", section) != "section")
		return { ok: false, error: "section_missing" };

	let snaps = require("jn_snapshots");
	let snap = snaps.snapshot_create("podkop", "apply");
	if (!snap.ok)
		return { ok: false, error: "snapshot_failed: " + snap.error };

	cursor.set("podkop", section, "proxy_config_type", "outbound");
	cursor.set("podkop", section, "outbound_json", text);
	cursor.set("podkop", section, "enabled", "1");
	cursor.delete("podkop", section, "proxy_string");
	cursor.delete("podkop", section, "selector_proxy_links");
	cursor.delete("podkop", section, "urltest_proxy_links");
	if (cursor.commit("podkop") == null) {
		snaps.snapshot_restore("podkop", snap.external_id, "local");
		return { ok: false, error: "uci commit failed" };
	}

	let res = reload("podkop");
	if (!res.ok) {
		snaps.snapshot_restore("podkop", snap.external_id, "local");
		reload("podkop");
		return { ok: false, error: res.error };
	}
	return { ok: true, section: section, mode: "outbound" };
}

function podkop_link_supported(link) {
	let res = run.run([ "sing-box", "tools", "decode-link", link ], 20);
	return res.ok;
}

function apply_podkop_connections(section, links, args) {
	let cursor = uci.cursor();
	let exists = cursor.get("podkop", section);
	if (exists == null)
		return { ok: false, error: "section_missing" };
	if (exists != "section")
		return { ok: false, error: "section_type_mismatch" };

	let valid = [];
	let skipped_links = [];
	for (let value in links) {
		if (podkop_link_supported(value))
			push(valid, value);
		else
			push(skipped_links, connection_mask(value).host);
	}
	if (length(valid) == 0 && length(links) > 0) {
		return {
			ok: false,
			error: "no_valid_links: " + join(", ", skipped_links)
		};
	}
	links = valid;

	let mode = util.as_string(args.proxy_config_type);
	if (mode != "url" && mode != "selector" && mode != "urltest")
		mode = podkop_proxy_mode(cursor, section);
	if (mode == "outbound") {
		if (length(links) == 0)
			return { ok: true, section: section, links: 0, subscriptions: 0, created: 0, mode: mode };
		return { ok: false, error: "podkop_outbound_managed_manually" };
	}

	let link_state = load_link_state();
	let previous = {};
	for (let hash in managed_link_hashes(link_state, "podkop", section))
		previous[util.as_string(hash)] = true;

	let preserved = [];
	for (let raw in podkop_proxy_links(cursor, section, mode)) {
		let value = trim(util.as_string(raw));
		if (value == "")
			continue;
		if (previous[util.sha256_hex(value)])
			continue;
		push(preserved, value);
	}
	let merged = util.dedupe(preserved);
	for (let value in links)
		push(merged, value);
	merged = util.dedupe(merged);

	// Podkop в режиме url хранит одну ссылку. Несколько ссылок требуют
	// selector/urltest — переключаем режим автоматически.
	if (mode == "url" && length(merged) > 1)
		mode = "selector";

	podkop_write_links(cursor, section, mode, merged);
	cursor.set("podkop", section, "proxy_config_type", mode);
	if (length(merged) > 0)
		cursor.set("podkop", section, "enabled", "1");

	let hashes = [];
	for (let value in links)
		push(hashes, util.sha256_hex(value));
	link_state["podkop:" + section] = hashes;
	save_link_state(link_state);

	if (cursor.commit("podkop") == null)
		return { ok: false, error: "uci commit failed" };
	return {
		ok: true, section: section, links: length(merged), subscriptions: 0,
		created: exists == null ? 1 : 0, mode: mode, skipped_links: skipped_links
	};
}

function apply_connections(product, args) {
	if (product != "forkop" && product != "prokop" && product != "podkop")
		return { ok: false, error: "неизвестный продукт" };
	args = type(args) == "object" ? args : {};

	let section = util.as_string(args.section);
	if (match(section, SECTION_RE) == null)
		return { ok: false, error: "invalid_section" };

	let links = [];
	for (let raw in (args.links || [])) {
		let value = trim(util.as_string(raw));
		if (match(value, LINK_RE) == null)
			return { ok: false, error: "invalid_link" };
		push(links, value);
		if (length(links) > 500)
			return { ok: false, error: "too_many_links" };
	}
	links = util.dedupe(links);

	if (product == "podkop")
		return apply_podkop_connections(section, links, args);

	let subscriptions = [];
	for (let raw in (args.subscriptions || [])) {
		let name = util.as_string(raw.name);
		let url = trim(util.as_string(raw.url));
		if (match(name, SECTION_RE) == null || match(url, SUBSCRIPTION_RE) == null)
			return { ok: false, error: "invalid_subscription" };
		push(subscriptions, { name: name, url: url });
		if (length(subscriptions) > 100)
			return { ok: false, error: "too_many_subscriptions" };
	}

	let cursor = uci.cursor();
	let exists = cursor.get(product, section);
	if (exists == null) {
		cursor.set(product, section, "section");
	} else if (exists != "section") {
		return { ok: false, error: "section_type_mismatch" };
	}

	let link_state = load_link_state();
	let previous = {};
	for (let hash in managed_link_hashes(link_state, product, section))
		previous[util.as_string(hash)] = true;

	let existing_links = cursor.get(product, section, "selector_proxy_links");
	if (type(existing_links) != "array")
		existing_links = existing_links == null ? [] : [ existing_links ];
	let preserved = [];
	for (let raw in existing_links) {
		let value = trim(util.as_string(raw));
		if (value == "")
			continue;
		// Удаляем только те ссылки, которые RoutX добавил сам.
		if (previous[util.sha256_hex(value)])
			continue;
		push(preserved, value);
	}
	preserved = util.dedupe(preserved);

	let merged_links = preserved;
	for (let value in links)
		push(merged_links, value);
	merged_links = util.dedupe(merged_links);

	let label = util.as_string(args.label);
	if (label == "")
		label = util.as_string(cursor.get(product, section, "label"));
	if (label == "")
		label = "RoutX";

	let action = util.as_string(args.action);
	if (action == "")
		action = "connection";
	if (action != "connection" && action != "proxy" && action != "outbound" &&
	    action != "vpn" && action != "bypass" && action != "block" && action != "dns")
		return { ok: false, error: "invalid_action" };

	let enabled = args.enabled == null ? true : util.is_true(args.enabled);
	cursor.set(product, section, "action", action);
	cursor.set(product, section, "label", label);
	cursor.delete(product, section, "selector_proxy_links");
	if (length(merged_links) > 0)
		cursor.set(product, section, "selector_proxy_links", merged_links);

	let all = cursor.get_all(product);
	if (type(all) != "object")
		all = {};
	let remove = [];
	for (let sname in all) {
		let sect = all[sname];
		if (type(sect) != "object" || sect[".type"] != "subscription_url")
			continue;
		if (util.as_string(sect.section) != section)
			continue;
		let real_name = sect[".name"] == null ? sname : util.as_string(sect[".name"]);
		if (match(real_name, /^rc_sub_/) != null)
			push(remove, sname);
	}
	let removed = {};
	for (let sname in remove) {
		removed[sname] = true;
		cursor.delete(product, sname);
	}

	// Собираем подписки, которые остались в секции после удаления старых
	// записей RoutX. Если такая ссылка уже есть, не создаём дубликат.
	all = cursor.get_all(product);
	if (type(all) != "object")
		all = {};
	let existing_urls = {};
	let foreign_subscriptions = 0;
	for (let sname in all) {
		if (removed[sname])
			continue;
		let sect = all[sname];
		if (type(sect) != "object" || sect[".type"] != "subscription_url")
			continue;
		if (util.as_string(sect.section) != section)
			continue;
		foreign_subscriptions = foreign_subscriptions + 1;
		let url = util.as_string(sect.url);
		if (url != "")
			existing_urls[url] = sname;
	}

	let created = 0;
	let skipped = [];
	for (let sub in subscriptions) {
		if (existing_urls[sub.url] != null) {
			push(skipped, sub.name);
			continue;
		}
		cursor.set(product, sub.name, "subscription_url");
		cursor.set(product, sub.name, "section", section);
		cursor.set(product, sub.name, "url", sub.url);
		cursor.set(product, sub.name, "subscription_update_enabled", "1");
		cursor.set(product, sub.name, "subscription_update_interval", "1h");
		cursor.set(product, sub.name, "download_via_proxy_enabled", "0");
		cursor.set(product, sub.name, "show_dashboard_metadata", "1");
		cursor.set(product, sub.name, "prefix_nodes", "0");
		cursor.set(product, sub.name, "include_urltest_groups", "1");
		created = created + 1;
	}

	// Внешние подписки и ссылки не должны выключаться только потому,
	// что RoutX удалил свои подключения.
	if (!enabled && (length(merged_links) > 0 || foreign_subscriptions > 0))
		enabled = true;
	if (!enabled && !has_other_enabled_section(product, cursor, section))
		return last_enabled_error();
	cursor.set(product, section, "enabled", enabled ? "1" : "0");

	if (cursor.commit(product) == null)
		return { ok: false, error: "uci commit failed" };

	let managed = [];
	for (let value in links)
		push(managed, util.sha256_hex(value));
	link_state[product + ":" + section] = util.dedupe(managed);
	save_link_state(link_state);

	return {
		ok: true,
		section: section,
		links: length(links),
		subscriptions: created,
		skipped_subscriptions: length(skipped),
		preserved_links: length(preserved),
		enabled: enabled
	};
}

return { precheck, verify, service_action, reload, apply_uci, apply_connections, list_connections, manage_connection, set_podkop_outbound, read_rules };
