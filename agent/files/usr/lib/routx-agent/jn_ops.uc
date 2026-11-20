// RoutX: операции apply/precheck/reload/service/verify
const fs = require("fs");
const uci = require("uci");
const util = require("jn_util");
const allow = require("jn_allowlist");
const run = require("jn_run");
const state = require("jn_uci_state");
const product_api = require("jn_product_api");

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

function podkop_temp_config_error() {
	let entries = fs.lsdir("/tmp") || [];
	for (let name in entries) {
		if (substr(name, 0, 4) != "tmp.")
			continue;
		let path = "/tmp/" + name;
		if (!util.file_exists(path) || util.file_size(path) == 0)
			continue;
		let res = run.run([ "sing-box", "check", "-c", path ], 60);
		if (!res.ok)
			return "temp " + path + ": " + run.error_text(res);
	}
	return "";
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
			let temp = podkop_temp_config_error();
			if (temp != "")
				tail = tail + " | " + temp;
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
	if (product != "forkop" && product != "prokop" && product != "podkop" && product != "tachyon")
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
	if (product != "forkop" && product != "prokop" && product != "podkop" && product != "tachyon")
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
	let mode = "selector";
	if (product == "podkop") {
		let configured = util.as_string(cursor.get("podkop", section, "proxy_config_type"));
		if (configured == "url" || configured == "selector" || configured == "urltest" || configured == "outbound")
			mode = configured;
		else if (cursor.get("podkop", section, "outbound_json") != null)
			mode = "outbound";
		else if (cursor.get("podkop", section, "urltest_proxy_links") != null)
			mode = "urltest";
		else if (cursor.get("podkop", section, "selector_proxy_links") != null)
			mode = "selector";
		else
			mode = "url";
	}
	let subscriptions = [];
	if (product != "podkop") {
		for (let sname in all) {
			let sect = all[sname];
			if (type(sect) != "object" || sect[".type"] != "subscription_url")
				continue;
			if (util.as_string(sect.section) != section)
				continue;
			let info = connection_mask(sect.url);
			push(subscriptions, { name: sname, tag: trim(util.as_string(sect.tag)), host: info.host, tail: info.tail });
		}
		// Tachyon хранит подписку в outbound_source, а не в subscription_url.
		for (let sname in all) {
			let sect = all[sname];
			if (type(sect) != "object" || sect[".type"] != "outbound_source")
				continue;
			if (util.as_string(sect.section) != section)
				continue;
			if (lc(util.as_string(sect.source_type)) != "subscription")
				continue;
			let url = util.as_string(sect.url);
			if (url == "")
				continue;
			let info = connection_mask(url);
			push(subscriptions, { name: sname, tag: trim(util.as_string(sect.tag)), host: info.host, tail: info.tail });
		}
	}

	let links = [];
	let raw = [];
	let link_keys = [];
	if (product == "podkop") {
		if (mode == "selector")
			link_keys = [ "selector_proxy_links" ];
		else if (mode == "urltest")
			link_keys = [ "urltest_proxy_links" ];
	} else {
		link_keys = [ "selector_proxy_links" ];
	}
	for (let key in link_keys) {
		let value = cursor.get(product, section, key);
		if (type(value) == "array") {
			for (let item in value)
				push(raw, item);
		} else if (value != null) {
			push(raw, value);
		}
	}
	if (product == "podkop" && mode == "url") {
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

	if (product != "podkop") {
		// Tachyon/Forkop 2.x хранят JSON-outbound отдельными элементами.
		let raw_jsons = cursor.get(product, section, "outbound_jsons");
		let json_items = type(raw_jsons) == "array" ? raw_jsons : (raw_jsons == null ? [] : [ raw_jsons ]);
		let json_index = 0;
		for (let raw_json in json_items) {
			let text = util.as_string(raw_json);
			if (text == "")
				continue;
			let parsed = util.json_parse(text);
			if (type(parsed) != "object")
				continue;
			let kind = util.as_string(parsed.type);
			let server = util.as_string(parsed.server);
			let port = util.as_string(parsed.server_port);
			let tag = util.as_string(parsed.tag);
			if (tag == "")
				tag = section + "-json-" + (json_index + 1) + "-out";
			let host = server;
			if (host != "" && port != "")
				host = host + ":" + port;
			push(links, {
				index: index_value + json_index,
				hash: util.sha256_hex(text),
				scheme: kind == "" ? "json" : kind,
				host: host,
				tail: "",
				label: tag,
				synthetic: true,
				proxy_tag: tag
			});
			json_index++;
		}
	}

	if (product == "podkop") {
		if (mode == "outbound") {
			let outbound_raw = util.as_string(cursor.get("podkop", section, "outbound_json"));
			if (outbound_raw != "") {
				let parsed = util.json_parse(outbound_raw);
				let kind = type(parsed) == "object" ? util.as_string(parsed.type) : "";
				let server = type(parsed) == "object" ? util.as_string(parsed.server) : "";
				let port = type(parsed) == "object" ? util.as_string(parsed.server_port) : "";
				let host = server;
				if (host != "" && port != "")
					host = host + ":" + port;
				push(links, {
					index: 0,
					hash: util.sha256_hex(outbound_raw),
					scheme: kind == "" ? "json" : kind,
					host: host,
					tail: "",
					label: "JSON outbound",
					synthetic: true
				});
			}
		}
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

function delete_section(product, args) {
	if (product != "forkop" && product != "prokop" && product != "podkop" && product != "tachyon")
		return { ok: false, error: "неизвестный продукт" };
	let section = util.as_string(args.section);
	if (match(section, SECTION_RE) == null)
		return { ok: false, error: "invalid_section" };

	let cursor = uci.cursor();
	let sect = cursor.get_all(product, section);
	if (type(sect) != "object" || sect[".type"] != "section")
		return { ok: false, error: "section_missing" };
	if (util.as_string(sect.enabled) != "0")
		return { ok: false, error: "section_enabled" };

	// Разрешаем только служебные поля секции. Любая настройка или ресурс
	// означают, что секция не пустая.
	for (let key in sect) {
		if (key == "" || substr(key, 0, 1) == ".")
			continue;
		if (key == "enabled" || key == "label" || key == "action" ||
		    key == "connection_type" || key == "proxy_config_type")
			continue;
		return { ok: false, error: "section_not_empty" };
	}

	// Дочерние объекты (подписки, outbound_source, section_interface и т.п.)
	// удалять вместе с секцией нельзя без явного согласия пользователя.
	let all = cursor.get_all(product);
	if (type(all) == "object") {
		for (let name in all) {
			let item = all[name];
			if (type(item) != "object" || name == section)
				continue;
			if (util.as_string(item.section) == section)
				return { ok: false, error: "section_has_children" };
		}
	}

	if (product == "tachyon") {
		let res = run.run_product("tachyon", [ "delete_section", section ], 90);
		if (!res.ok)
			return { ok: false, error: run.error_text(res) };
		return {
			ok: true,
			section: section,
			deleted: true,
			output: util.truncate_text(res.stdout, 2000)
		};
	}

	cursor.delete(product, section);
	if (cursor.commit(product) == null)
		return { ok: false, error: "uci commit failed" };
	let reload_res = reload(product);
	if (!reload_res.ok)
		return { ok: false, error: reload_res.error };
	return { ok: true, section: section, deleted: true };
}

function manage_connection(product, args) {
	if (product != "forkop" && product != "prokop" && product != "podkop" && product != "tachyon")
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
		let source_type = cursor.get(product, name);
		if (source_type == "subscription_url") {
			if (util.as_string(cursor.get(product, name, "section")) != section)
				return { ok: false, error: "subscription_section_mismatch" };
			if (action == "delete")
				cursor.delete(product, name);
			else {
				cursor.set(product, name, "url", value);
				cursor.delete(product, name, "user_agent");
				cursor.delete(product, name, "hwid");
				cursor.delete(product, name, "tag");
			}
		} else if (product == "tachyon" && source_type == "outbound_source") {
			if (lc(util.as_string(cursor.get(product, name, "source_type"))) != "subscription")
				return { ok: false, error: "subscription_missing" };
			if (util.as_string(cursor.get(product, name, "section")) != section)
				return { ok: false, error: "subscription_section_mismatch" };
			if (action == "delete") {
				cursor.delete(product, name);
				let refs = cursor.get(product, section, "outbound_source_refs");
				if (type(refs) != "array")
					refs = refs == null ? [] : [ refs ];
				let keep = [];
				for (let ref in refs) {
					let ref_value = util.as_string(ref);
					if (ref_value != "" && ref_value != name)
						push(keep, ref_value);
				}
				cursor.delete(product, section, "outbound_source_refs");
				if (length(keep) > 0)
					cursor.set(product, section, "outbound_source_refs", keep);
			} else {
				cursor.set(product, name, "url", value);
				cursor.set(product, name, "enabled", "1");
				cursor.delete(product, name, "user_agent");
				cursor.delete(product, name, "hwid");
				cursor.delete(product, name, "tag");
				let refs = cursor.get(product, section, "outbound_source_refs");
				if (type(refs) != "array")
					refs = refs == null ? [] : [ refs ];
				let refs_next = [];
				for (let ref in refs) {
					let ref_value = util.as_string(ref);
					if (ref_value != "")
						push(refs_next, ref_value);
				}
				push(refs_next, name);
				cursor.delete(product, section, "outbound_source_refs");
				cursor.set(product, section, "outbound_source_refs", util.dedupe(refs_next));
			}
		} else {
			return { ok: false, error: "subscription_missing" };
		}
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
			if (product == "tachyon" && type(sect) == "object" && sect[".type"] == "outbound_source" &&
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
	if (product == "tachyon" && action == "replace" && kind == "subscription")
		run.run_product("tachyon", [ "subscription_update_if_due" ], 180);
	return { ok: true, section: section, action: action, kind: kind, disabled: disabled };
}

/**
 * Живое чтение всех правил: настройки секций, подписки, прямые ссылки
 * и содержимое локальных .lst. Один вызов вместо list_connections на каждую
 * секцию. Секреты по-прежнему не отдаются: только host/tail/hash.
 */
function proxy_last_delay(proxy) {
	if (type(proxy) != "object" || type(proxy.history) != "array")
		return null;
	for (let i = length(proxy.history) - 1; i >= 0; i--) {
		let item = proxy.history[i];
		if (type(item) == "object" && (type(item.delay) == "int" || type(item.delay) == "double") && item.delay > 0)
			return item.delay;
	}
	return null;
}

function read_proxies(product) {
	let res = product_api.get_proxies(product, 20);
	if (!res.ok || type(res.value.proxies) != "object")
		return null;
	return res.value.proxies;
}

function proxy_group_tag(product, section) {
	if (product_api.is_forkop_v2(product)) {
		let cursor = uci.cursor();
		let label = trim(util.as_string(cursor.get(product, section, "label")));
		return label != "" ? label : section;
	}
	return section + "-out";
}

function proxy_is_group(proxy) {
	if (type(proxy) != "object")
		return false;
	let kind = lc(util.as_string(proxy.type));
	return kind == "selector" || kind == "urltest" || kind == "fallback";
}

function collect_proxy_members(proxies, tag, seen, out) {
	if (tag == "" || seen[tag] === true)
		return;
	seen[tag] = true;
	let info = proxies[tag];
	if (type(info) != "object")
		return;
	if (proxy_is_group(info) && type(info.all) == "array") {
		for (let member in info.all)
			collect_proxy_members(proxies, util.as_string(member), seen, out);
		return;
	}
	push(out, tag);
}

// Forkop 2.x держит подписку провайдером, поэтому её серверы не видны
// в selector_proxy_links. Достаём их из членов группы Clash API.
function subscription_links(product, section, proxies, existing, subscriptions) {
	let links = [];
	if ((!product_api.is_forkop_v2(product) && product != "tachyon") || type(proxies) != "object" || length(subscriptions) == 0)
		return links;
	let group_tag = proxy_group_tag(product, section);
	let group = proxies[group_tag];
	if (type(group) != "object")
		return links;
	let seen = {};
	for (let item in existing)
		if (util.as_string(item.proxy_tag) != "")
			seen[util.as_string(item.proxy_tag)] = true;
	let members = [];
	collect_proxy_members(proxies, group_tag, {}, members);
	let index_value = length(existing);
	for (let member in members) {
		if (seen[member] === true)
			continue;
		let info = proxies[member];
		let label = member;
		let prefix = group_tag + "/";
		if (substr(label, 0, length(prefix)) == prefix)
			label = substr(label, length(prefix));
		// Провайдер подписки добавляет свой tag: sub2/<имя сервера>.
		for (let subscription in subscriptions) {
			let tag = trim(util.as_string(subscription.tag));
			let sub_prefix = tag + "/";
			if (tag != "" && substr(label, 0, length(sub_prefix)) == sub_prefix) {
				label = substr(label, length(sub_prefix));
				break;
			}
		}
		let delay = proxy_last_delay(info);
		push(links, {
			index: index_value++,
			hash: util.sha256_hex(member),
			scheme: "proxy",
			host: label,
			tail: "",
			label: label,
			proxy_tag: member,
			proxy_group: group_tag,
			delay_ms: delay,
			alive: delay != null,
			active: util.as_string(group.now) == member,
			selectable: true,
			native: true
		});
	}
	return links;
}

function enrich_links(product, section, links, proxies) {
	let enriched = [];
	if (type(proxies) != "object") {
		for (let link in links)
			push(enriched, link);
		return enriched;
	}
	let mode = "selector";
	if (product == "podkop") {
		let cursor = uci.cursor();
		let configured = util.as_string(cursor.get("podkop", section, "proxy_config_type"));
		if (configured == "url" || configured == "selector" || configured == "urltest" || configured == "outbound")
			mode = configured;
		else if (cursor.get("podkop", section, "outbound_json") != null)
			mode = "outbound";
		else if (cursor.get("podkop", section, "urltest_proxy_links") != null)
			mode = "urltest";
		else if (cursor.get("podkop", section, "selector_proxy_links") != null)
			mode = "selector";
		else
			mode = "url";
	}
	let group_tag = section + "-out";
	if (product_api.is_forkop_v2(product)) {
		let cursor = uci.cursor();
		let label = trim(util.as_string(cursor.get(product, section, "label")));
		group_tag = label != "" ? label : section;
	}
	let group = proxies[group_tag];
	for (let i = 0; i < length(links); i++) {
		let link = links[i];
		let tag = trim(util.as_string(link.proxy_tag));
		if (tag == "") {
			if (product_api.is_forkop_v2(product)) {
				let child = trim(util.as_string(link.label));
				if (child == "")
					child = trim(util.as_string(link.host));
				if (child == "")
					child = "" + (i + 1);
				tag = group_tag + "/" + child;
			} else {
				tag = mode == "url" || mode == "outbound" ? group_tag : section + "-" + (i + 1) + "-out";
			}
		}
		let info = proxies[tag];
		let delay = proxy_last_delay(info);
		link.proxy_tag = tag;
		link.proxy_group = group_tag;
		link.delay_ms = delay;
		link.alive = delay != null;
		link.active = type(group) == "object" && util.as_string(group.now) == tag;
		link.selectable = false;
		if (type(group) == "object" && type(group.all) == "array") {
			for (let member in group.all)
				if (util.as_string(member) == tag)
					link.selectable = true;
		}
		if (mode == "url" || mode == "outbound")
			link.active = true;
		push(enriched, link);
	}
	return enriched;
}

function select_proxy(product, args) {
	let group = util.as_string(args.group);
	let tag = util.as_string(args.tag);
	if (group == "" || tag == "" || length(group) > 200 || length(tag) > 200 ||
		match(group, /[\n\r]/) != null || match(tag, /[\n\r]/) != null)
		return { ok: false, error: "invalid_proxy_tag" };
	if (product != "forkop" && product != "prokop" && product != "podkop" && product != "tachyon")
		return { ok: false, error: "неизвестный продукт" };
	let res = product_api.set_group_proxy(product, group, tag);
	if (!res.ok)
		return { ok: false, error: res.error };
	return { ok: true, group: group, tag: tag };
}

function read_rules(product) {
	if (product != "forkop" && product != "prokop" && product != "podkop" && product != "tachyon")
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
	let proxies = read_proxies(product);
	for (let name in names) {
		let options = {};
		let prefix = "section." + name + ".";
		for (let path in managed) {
			if (substr(path, 0, length(prefix)) == prefix)
				options[substr(path, length(prefix))] = managed[path];
		}

		let conn = list_connections(product, { section: name });
		let links = [];
		if (conn.ok) {
			links = enrich_links(product, name, conn.links, proxies);
			for (let item in subscription_links(product, name, proxies, links, conn.subscriptions))
				push(links, item);
		}
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
			links: links,
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
		// Пользователь добавляет ссылки в секцию, которая была outbound_json:
		// переключаем её на selector и убираем старый JSON outbound.
		mode = "selector";
		cursor.delete("podkop", section, "outbound_json");
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

function cleanup_json_outbounds(product) {
	if (product != "forkop" && product != "tachyon")
		return { ok: true, removed: 0 };
	let cursor = uci.cursor();
	let all = cursor.get_all(product);
	if (type(all) != "object")
		return { ok: true, removed: 0 };
	let json_sources = {};
	for (let sname in all) {
		let sect = all[sname];
		if (type(sect) != "object" || sect[".type"] != "outbound_source")
			continue;
		if (util.as_string(sect.source_type) == "outbound_json")
			json_sources[sname] = true;
	}
	let removed = 0;
	for (let sname in all) {
		let sect = all[sname];
		if (type(sect) != "object" || sect[".type"] != "section")
			continue;
		let refs = sect.outbound_source_refs;
		if (type(refs) != "array")
			refs = refs == null ? [] : [ refs ];
		let keep = [];
		for (let ref in refs) {
			let value = util.as_string(ref);
			if (value == "" || json_sources[value] === true)
				continue;
			push(keep, value);
		}
		if (length(keep) != length(refs)) {
			cursor.delete(product, sname, "outbound_source_refs");
			if (length(keep) > 0)
				cursor.set(product, sname, "outbound_source_refs", keep);
		}
		if (sect.outbound_jsons != null) {
			cursor.delete(product, sname, "outbound_jsons");
			removed++;
		}
		if (sect.outbound_json != null) {
			cursor.delete(product, sname, "outbound_json");
			removed++;
		}
	}
	for (let sname in json_sources) {
		cursor.delete(product, sname);
		removed++;
	}
	if (removed > 0)
		cursor.commit(product);
	return { ok: true, removed: removed };
}

function restore_section_options(product, args) {
	if (product != "forkop" && product != "prokop" && product != "podkop" && product != "tachyon")
		return { ok: false, error: "неизвестный продукт" };
	let section = util.as_string(args.section);
	if (match(section, SECTION_RE) == null)
		return { ok: false, error: "invalid_section" };
	let options = type(args.options) == "object" ? args.options : {};
	let cursor = uci.cursor();
	if (cursor.get(product, section) == null)
		cursor.set(product, section, "section");
	let restored = [];
	let allowed = [
		"community_lists", "rule_set", "rule_set_with_subnets", "domain",
		"domain_suffix", "domain_keyword", "domain_regex", "domain_ip_lists",
		"user_domains", "user_domains_text", "user_subnets", "user_subnets_text",
		"local_domain_lists", "local_subnet_lists", "fully_routed_ips",
		"enable_udp_over_tcp", "mixed_proxy_enabled", "resolve_real_ip_for_routing",
		"user_domain_list_type", "user_subnet_list_type"
	];
	for (let key in allowed) {
		if (options[key] == null)
			continue;
		let option_value = options[key];
		if (product == "tachyon" && (key == "rule_set" || key == "rule_set_with_subnets")) {
			let list = type(option_value) == "array" ? option_value : [ option_value ];
			let next = [];
			for (let item in list) {
				let mapped = tachyon_rule_set_url(item);
				if (mapped != "")
					push(next, mapped);
			}
			if (length(next) == 0)
				continue;
			option_value = util.dedupe(next);
		}
		if (product == "tachyon" && key == "community_lists") {
			let list = type(option_value) == "array" ? option_value : [ option_value ];
			let next = [];
			for (let item in list) {
				let mapped = tachyon_community_list(item);
				if (mapped != "")
					push(next, mapped);
			}
			if (length(next) == 0)
				continue;
			option_value = util.dedupe(next);
		}
		cursor.set(product, section, key, option_value);
		push(restored, key);
	}
	let label = util.as_string(args.label);
	if (label != "")
		cursor.set(product, section, "label", label);
	let enabled = args.enabled == null ? "1" : util.as_string(args.enabled);
	cursor.set(product, section, "enabled", enabled == "0" ? "0" : "1");
	if (product == "podkop") {
		cursor.set(product, section, "connection_type", util.as_string(args.connection_type) != "" ? util.as_string(args.connection_type) : "proxy");
		cursor.set(product, section, "proxy_config_type", util.as_string(args.proxy_config_type) != "" ? util.as_string(args.proxy_config_type) : "selector");
	} else {
		cursor.set(product, section, "action", util.as_string(args.action) != "" ? util.as_string(args.action) : "connection");
	}
	if (cursor.commit(product) == null)
		return { ok: false, error: "uci commit failed" };
	let reload_res = reload(product);
	if (!reload_res.ok)
		return { ok: false, error: reload_res.error };
	return { ok: true, section: section, restored: restored };
}

const PRODUCT_MIGRATION_FILE = util.STATE_DIR + "/product-migration.json";
const MIGRATION_OPTIONS = [
	"community_lists", "rule_set", "rule_set_with_subnets", "domain",
	"domain_suffix", "domain_keyword", "domain_regex", "domain_ip_lists",
	"user_domains", "user_domains_text", "user_subnets", "user_subnets_text",
	"local_domain_lists", "local_subnet_lists", "fully_routed_ips",
	"enable_udp_over_tcp", "mixed_proxy_enabled", "resolve_real_ip_for_routing",
	"user_domain_list_type", "user_subnet_list_type"
];

function migration_append_list(target, value) {
	if (type(value) == "array") {
		for (let item in value) {
			let text = util.as_string(item);
			if (text != "")
				push(target, text);
		}
	} else {
		let text = util.as_string(value);
		if (text != "")
			push(target, text);
	}
}

function migration_copy_options(cursor, product, name, options) {
	if (type(options) != "object")
		return;
	for (let key in options) {
		if (key == "" || substr(key, 0, 1) == "." || key == "url" || key == "section" ||
		    key == "name" || key == "source_type" || key == "enabled")
			continue;
		cursor.set(product, name, key, options[key]);
	}
}

function capture_product_config(from, to) {
	let cursor = uci.cursor();
	let all = cursor.get_all(from);
	if (type(all) != "object")
		return { ok: true, sections: 0, subscriptions: 0, links: 0 };
	let sections = [];
	let subscription_count = 0;
	let link_count = 0;
	for (let sname in all) {
		let sect = all[sname];
		if (type(sect) != "object" || sect[".type"] != "section")
			continue;
		let section = util.as_string(sect[".name"]) != "" ? util.as_string(sect[".name"]) : sname;
		if (match(section, SECTION_RE) == null)
			continue;
		let item = {
			name: section,
			label: util.as_string(sect.label),
			enabled: util.as_string(sect.enabled),
			action: util.as_string(sect.action),
			connection_type: util.as_string(sect.connection_type),
			proxy_config_type: util.as_string(sect.proxy_config_type),
			options: {},
			subscriptions: [],
			links: []
		};
		for (let key in MIGRATION_OPTIONS) {
			if (sect[key] != null)
				item.options[key] = sect[key];
		}
		for (let key in [ "selector_proxy_links", "proxy_links", "urltest_proxy_links", "proxy_string" ]) {
			if (sect[key] != null) {
				migration_append_list(item.links, sect[key]);
			}
		}
		for (let other in all) {
			let child = all[other];
			if (type(child) != "object")
				continue;
			if (child[".type"] == "subscription_url" && util.as_string(child.section) == section) {
				if (util.as_string(child.url) != "") {
					let sub_options = {};
					for (let option in child) {
						if (option == "" || substr(option, 0, 1) == "." || option == "url" || option == "section" || option == "name")
							continue;
						sub_options[option] = child[option];
					}
					push(item.subscriptions, {
						url: util.as_string(child.url),
						label: util.as_string(child.name),
						options: sub_options
					});
					subscription_count++;
				}
			}
			if (child[".type"] != "outbound_source" || util.as_string(child.section) != section)
				continue;
			let source_type = lc(util.as_string(child.source_type));
			if (source_type == "subscription") {
				if (util.as_string(child.url) != "") {
					let sub_options = {};
					for (let option in child) {
						if (option == "" || substr(option, 0, 1) == "." || option == "url" || option == "section" || option == "name" || option == "source_type")
							continue;
						sub_options[option] = child[option];
					}
					push(item.subscriptions, {
						url: util.as_string(child.url),
						label: util.as_string(child.name),
						options: sub_options
					});
					subscription_count++;
				}
			} else if (source_type == "proxy_links") {
				migration_append_list(item.links, child.proxy_links);
			}
		}
		item.links = util.dedupe(item.links);
		link_count += length(item.links);
		push(sections, item);
	}
	let model = { from: from, to: to, sections: sections };
	util.mkdir_p(util.STATE_DIR, 0700);
	if (!util.write_atomic(PRODUCT_MIGRATION_FILE, util.json_string(model) + "\n", 0600))
		return { ok: false, error: "migration_file_failed" };
	return { ok: true, sections: length(sections), subscriptions: subscription_count, links: link_count };
}

function apply_product_config(to) {
	let text = util.read_file(PRODUCT_MIGRATION_FILE, "");
	if (trim(text) == "")
		return { ok: true, applied: 0, subscriptions: 0, links: 0 };
	let model = util.json_parse(text);
	if (type(model) != "object" || type(model.sections) != "array")
		return { ok: false, error: "invalid_migration_file" };
	if (util.as_string(model.to) != "" && util.as_string(model.to) != to)
		return { ok: true, applied: 0, subscriptions: 0, links: 0, skipped: true };
	if (!util.file_exists("/etc/config/" + to))
		util.write_atomic("/etc/config/" + to, "\n", 0600);
	let cursor = uci.cursor();
	let applied = 0;
	let subscriptions = 0;
	let links = 0;
	let warnings = [];
	for (let item in model.sections) {
		let section = util.as_string(item.name);
		if (match(section, SECTION_RE) == null)
			continue;
		if (cursor.get(to, section) == null)
			cursor.set(to, section, "section");
		if (util.as_string(item.label) != "")
			cursor.set(to, section, "label", item.label);
		if (util.as_string(item.enabled) != "")
			cursor.set(to, section, "enabled", item.enabled);
		if (to == "podkop") {
			cursor.set(to, section, "connection_type", util.as_string(item.connection_type) != "" ? item.connection_type : "proxy");
			cursor.set(to, section, "proxy_config_type", util.as_string(item.proxy_config_type) != "" ? item.proxy_config_type : "selector");
		} else {
			cursor.set(to, section, "action", util.as_string(item.action) != "" ? item.action : "connection");
		}
		for (let key in MIGRATION_OPTIONS) {
			if (item.options[key] != null)
				cursor.set(to, section, key, item.options[key]);
		}

		if (to == "tachyon") {
			let refs = [];
			let existing = cursor.get(to, section, "outbound_source_refs");
			if (type(existing) == "array") {
				for (let ref in existing) {
					let value = util.as_string(ref);
					if (value != "")
						push(refs, value);
				}
			} else if (existing != null) {
				push(refs, util.as_string(existing));
			}
			let sub_index = 0;
			for (let sub in item.subscriptions) {
				sub_index++;
				let source = "src_sub_" + replace(section, /[^A-Za-z0-9_]/g, "_");
				if (sub_index > 1)
					source += "_" + sub_index;
				cursor.delete(to, source);
				cursor.set(to, source, "outbound_source");
				cursor.set(to, source, "section", section);
				cursor.set(to, source, "enabled", "1");
				cursor.set(to, source, "name", util.as_string(sub.label) != "" ? sub.label : "Подписка");
				cursor.set(to, source, "source_type", "subscription");
				cursor.set(to, source, "url", sub.url);
				cursor.set(to, source, "subscription_update_enabled", util.as_string(sub.update_enabled) != "" ? sub.update_enabled : "1");
				cursor.set(to, source, "subscription_update_interval", util.as_string(sub.update_interval) != "" ? sub.update_interval : "1h");
				cursor.set(to, source, "download_via_proxy_enabled", util.as_string(sub.download_via_proxy) != "" ? sub.download_via_proxy : "0");
				cursor.set(to, source, "prefix_nodes", "0");
				cursor.set(to, source, "include_urltest_groups", "1");
				migration_copy_options(cursor, to, source, sub.options);
				push(refs, source);
				subscriptions++;
			}
			if (length(item.links) > 0) {
				let source = "src_links_" + replace(section, /[^A-Za-z0-9_]/g, "_");
				cursor.delete(to, source);
				cursor.set(to, source, "outbound_source");
				cursor.set(to, source, "section", section);
				cursor.set(to, source, "enabled", "1");
				cursor.set(to, source, "name", "Ссылки");
				cursor.set(to, source, "source_type", "proxy_links");
				cursor.set(to, source, "proxy_links", item.links);
				push(refs, source);
				links += length(item.links);
			}
			refs = util.dedupe(refs);
			if (length(refs) > 0) {
				cursor.delete(to, section, "outbound_source_refs");
				cursor.set(to, section, "outbound_source_refs", refs);
			}
		} else if (to == "forkop" || to == "prokop") {
			let sub_index = 0;
			for (let sub in item.subscriptions) {
				sub_index++;
				let name = "sub_" + replace(section, /[^A-Za-z0-9_]/g, "_");
				if (sub_index > 1)
					name += "_" + sub_index;
				cursor.delete(to, name);
				cursor.set(to, name, "subscription_url");
				cursor.set(to, name, "section", section);
				cursor.set(to, name, "name", util.as_string(sub.label) != "" ? sub.label : "Подписка");
				cursor.set(to, name, "url", sub.url);
				cursor.set(to, name, "subscription_update_enabled", util.as_string(sub.update_enabled) != "" ? sub.update_enabled : "1");
				cursor.set(to, name, "subscription_update_interval", util.as_string(sub.update_interval) != "" ? sub.update_interval : "1h");
				cursor.set(to, name, "download_via_proxy_enabled", util.as_string(sub.download_via_proxy) != "" ? sub.download_via_proxy : "0");
				migration_copy_options(cursor, to, name, sub.options);
				subscriptions++;
			}
			if (length(item.links) > 0) {
				cursor.set(to, section, "selector_proxy_links", item.links);
				links += length(item.links);
			}
		} else if (to == "podkop") {
			if (length(item.links) > 0) {
				cursor.set(to, section, "connection_type", "proxy");
				cursor.set(to, section, "proxy_config_type", "selector");
				cursor.set(to, section, "selector_proxy_links", item.links);
				links += length(item.links);
			}
			if (length(item.subscriptions) > 0) {
				let sub_index = 0;
				for (let sub in item.subscriptions) {
					sub_index++;
					let name = "sub_" + replace(section, /[^A-Za-z0-9_]/g, "_");
					if (sub_index > 1)
						name += "_" + sub_index;
					cursor.set(to, name, "subscription_url");
					cursor.set(to, name, "section", section);
					cursor.set(to, name, "name", util.as_string(sub.label) != "" ? sub.label : "Подписка");
					cursor.set(to, name, "url", sub.url);
					migration_copy_options(cursor, to, name, sub.options);
					push(warnings, "podkop_subscription:" + section);
				}
				subscriptions += length(item.subscriptions);
			}
		}
		applied++;
	}
	if (cursor.commit(to) == null)
		return { ok: false, error: "uci commit failed" };
	let reload_res = reload(to);
	if (!reload_res.ok)
		push(warnings, "reload:" + reload_res.error);
	if (to == "tachyon") {
		let update_res = run.run_product("tachyon", [ "subscription_update_if_due" ], 180);
		if (!update_res.ok)
			push(warnings, "subscription_update:" + run.error_text(update_res));
	}
	try { fs.unlink(PRODUCT_MIGRATION_FILE); } catch (e) {}
	return {
		ok: true,
		applied: applied,
		subscriptions: subscriptions,
		links: links,
		warnings: warnings
	};
}

function tachyon_rule_set_url(value) {
	let url = util.as_string(value);
	let m = match(url, /forkop-lists\/releases\/latest\/download\/([A-Za-z0-9_.-]+)\.json$/);
	if (m != null)
		return "https://github.com/itdoginfo/allow-domains/releases/latest/download/" + m[1] + ".srs";
	if (match(url, /\.json$/) != null)
		return "";
	return url;
}

function tachyon_community_list(value) {
	let id = lc(util.as_string(value));
	// Forkop 2.x имена -> имена, которые понимает Tachyon (COMMUNITY_SERVICES).
	if (id == "facebook" || id == "instagram")
		return "meta";
	if (id == "x")
		return "twitter";
	if (id == "gemini" || id == "ai")
		return "google_ai";
	if (id == "chatgpt")
		return "openai";
	if (id == "claude")
		return "anthropic";
	if (id == "ads")
		return "ads_hagezi_pro";
	if (id == "ru_blocked_geo")
		return "geoblock";
	if (id == "ru_blocked_rkn")
		return "ru_blocked";
	if (id == "ru_only")
		return "russia_inside";
	if (id == "ru_blocked_all")
		return "russia_outside";
	if (id == "ua_blocked")
		return "ukraine_inside";
	return util.as_string(value);
}

function migrate_tachyon_lists() {
	let cursor = uci.cursor();
	let all = cursor.get_all("tachyon");
	if (type(all) != "object")
		return { ok: true, changed: 0 };
	let changed = 0;
	for (let sname in all) {
		let sect = all[sname];
		if (type(sect) != "object")
			continue;
		// Обрабатываем и обычные section, и сгенерированные condition-секции
		// (cond_*): Tachyon хранит копию community_lists и rule_set в них.
		for (let key in [ "rule_set", "rule_set_with_subnets", "community_lists" ]) {
			let raw = cursor.get("tachyon", sname, key);
			if (raw == null)
				continue;
			let list = type(raw) == "array" ? raw : [ raw ];
			let next = [];
			let dirty = false;
			for (let item in list) {
				let original = util.as_string(item);
				let mapped = key == "community_lists" ? tachyon_community_list(original) : tachyon_rule_set_url(original);
				if (mapped != original)
					dirty = true;
				if (mapped != "")
					push(next, mapped);
			}
			if (dirty) {
				cursor.delete("tachyon", sname, key);
				if (length(next) > 0)
					cursor.set("tachyon", sname, key, util.dedupe(next));
				changed++;
			}
		}
	}
	if (changed > 0) {
		if (cursor.commit("tachyon") == null)
			return { ok: false, error: "uci commit failed" };
		let reload_res = reload("tachyon");
		if (!reload_res.ok)
			return { ok: false, error: reload_res.error };
	}
	return { ok: true, changed: changed };
}

function apply_tachyon_subscription(section, subscriptions, args) {
	let stage = "init";
	try {
	let sub = subscriptions[0];
	if (type(sub) != "object" || util.as_string(sub.url) == "")
		return { ok: false, error: "invalid_subscription" };
	stage = "cursor";
	let cursor = uci.cursor();
	if (cursor.get("tachyon", section) == null)
		cursor.set("tachyon", section, "section");
	stage = "get_all";
	let all = cursor.get_all("tachyon");
	if (type(all) != "object")
		all = {};

	// Убираем JSON и старые источники подключений; DPI/desync-источники
	// (zapret/byedpi/desync) не трогаем.
	stage = "scan_sources";
	let source_ids = {};
	for (let sname in all) {
		let sect = all[sname];
		if (type(sect) != "object" || sect[".type"] != "outbound_source")
			continue;
		let stype = lc(util.as_string(sect.source_type));
		if (stype == "zapret" || stype == "zapret2" || stype == "byedpi" || stype == "desync")
			continue;
		source_ids[sname] = true;
	}
	stage = "refs";
	let refs = all[section] != null && all[section].outbound_source_refs != null
		? all[section].outbound_source_refs
		: [];
	if (type(refs) != "array")
		refs = [ refs ];
	let keep = [];
	for (let ref in refs) {
		let value = util.as_string(ref);
		if (value != "" && source_ids[value] !== true)
			push(keep, value);
	}
	stage = "delete_sources";
	for (let sname in source_ids)
		cursor.delete("tachyon", sname);
	for (let key in [ "selector_proxy_links", "proxy_links", "outbound_jsons", "outbound_json" ])
		cursor.delete("tachyon", section, key);

	stage = "create_source";
	let source_name = "src_sub_" + replace(section, /[^A-Za-z0-9_]/g, "_");
	cursor.delete("tachyon", source_name);
	cursor.set("tachyon", source_name, "outbound_source");
	cursor.set("tachyon", source_name, "section", section);
	cursor.set("tachyon", source_name, "enabled", "1");
	cursor.set("tachyon", source_name, "name", util.as_string(sub.label) != "" ? util.as_string(sub.label) : "Подписка");
	cursor.set("tachyon", source_name, "source_type", "subscription");
	cursor.set("tachyon", source_name, "url", util.as_string(sub.url));
	cursor.set("tachyon", source_name, "subscription_update_enabled", "1");
	cursor.set("tachyon", source_name, "subscription_update_interval", "1h");
	cursor.set("tachyon", source_name, "download_via_proxy_enabled", "0");
	cursor.set("tachyon", source_name, "prefix_nodes", "0");
	cursor.set("tachyon", source_name, "include_urltest_groups", "1");

	stage = "link_source";
	keep = util.dedupe(keep);
	push(keep, source_name);
	cursor.delete("tachyon", section, "outbound_source_refs");
	cursor.set("tachyon", section, "outbound_source_refs", keep);
	cursor.set("tachyon", section, "enabled", "1");
	cursor.set("tachyon", section, "action", "connection");
	stage = "commit";
	if (cursor.commit("tachyon") == null)
		return { ok: false, error: "uci commit failed" };
	stage = "reload";
	let reload_res = reload("tachyon");
	if (!reload_res.ok)
		return { ok: false, error: reload_res.error };
	return { ok: true, section: section, subscriptions: 1, source: source_name };
	} catch (e) {
		return { ok: false, error: "tachyon_subscription_" + stage + ": " + e.message };
	}
}

function migrate_legacy_tachyon_subscriptions() {
	let stage = "init";
	try {
		let cursor = uci.cursor();
		let all = cursor.get_all("tachyon");
		if (type(all) != "object")
			return { ok: true, migrated: 0 };
		let legacy = [];
		for (let sname in all) {
			let sect = all[sname];
			if (type(sect) != "object" || sect[".type"] != "subscription_url")
				continue;
			let section = util.as_string(sect.section);
			let url = util.as_string(sect.url);
			if (section == "" || url == "")
				continue;
			push(legacy, {
				name: sname,
				section: section,
				url: url,
				label: util.as_string(sect.name)
			});
		}
		if (length(legacy) == 0)
			return { ok: true, migrated: 0 };
		stage = "migrate";
		let migrated_sections = [];
		let index = 0;
		for (let sub in legacy) {
			index = index + 1;
			let source_name = "src_sub_" + replace(sub.section, /[^A-Za-z0-9_]/g, "_");
			if (index > 1)
				source_name = source_name + "_" + index;
			cursor.delete("tachyon", source_name);
			cursor.set("tachyon", source_name, "outbound_source");
			cursor.set("tachyon", source_name, "section", sub.section);
			cursor.set("tachyon", source_name, "enabled", "1");
			cursor.set("tachyon", source_name, "name", sub.label != "" ? sub.label : "Подписка");
			cursor.set("tachyon", source_name, "source_type", "subscription");
			cursor.set("tachyon", source_name, "url", sub.url);
			cursor.set("tachyon", source_name, "subscription_update_enabled", "1");
			cursor.set("tachyon", source_name, "subscription_update_interval", "1h");
			cursor.set("tachyon", source_name, "download_via_proxy_enabled", "0");
			cursor.set("tachyon", source_name, "prefix_nodes", "0");
			cursor.set("tachyon", source_name, "include_urltest_groups", "1");

			let refs = cursor.get("tachyon", sub.section, "outbound_source_refs");
			if (refs == null)
				refs = [];
			else if (type(refs) != "array")
				refs = [ refs ];
			let keep = [];
			for (let ref in refs) {
				let value = util.as_string(ref);
				if (value != "")
					push(keep, value);
			}
			keep = util.dedupe(keep);
			push(keep, source_name);
			cursor.delete("tachyon", sub.section, "outbound_source_refs");
			cursor.set("tachyon", sub.section, "outbound_source_refs", keep);
			cursor.set("tachyon", sub.section, "enabled", "1");
			cursor.set("tachyon", sub.section, "action", "connection");
			cursor.delete("tachyon", sub.name);
			push(migrated_sections, sub.section);
		}
		stage = "commit";
		if (cursor.commit("tachyon") == null)
			return { ok: false, error: "uci commit failed" };
		stage = "reload";
		let reload_res = reload("tachyon");
		if (!reload_res.ok)
			return { ok: false, error: reload_res.error };
		return { ok: true, migrated: length(legacy), sections: util.dedupe(migrated_sections) };
	} catch (e) {
		return { ok: false, error: "tachyon_legacy_migration_" + stage + ": " + e.message };
	}
}

function apply_connections(product, args) {
	if (product != "forkop" && product != "prokop" && product != "podkop" && product != "tachyon")
		return { ok: false, error: "неизвестный продукт" };
	args = type(args) == "object" ? args : {};

	let section = util.as_string(args.section);
	if (match(section, SECTION_RE) == null)
		return { ok: false, error: "invalid_section" };

	let stage = "links";
	try {
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
	stage = "subscriptions";
	if (args.subscriptions != null && type(args.subscriptions) != "array")
		return { ok: false, error: "subscriptions_not_array:" + type(args.subscriptions) + ":" + sprintf("%J", args.subscriptions) };
	for (let raw in (args.subscriptions || [])) {
		try {
		let name = util.as_string(raw.name);
		let url = trim(util.as_string(raw.url));
		let label = trim(util.as_string(raw.label));
		if (match(name, SECTION_RE) == null || match(url, SUBSCRIPTION_RE) == null)
			return { ok: false, error: "invalid_subscription" };
		push(subscriptions, { name: name, url: url, label: substr(label, 0, 120) });
		if (length(subscriptions) > 100)
			return { ok: false, error: "too_many_subscriptions" };
		} catch (e) {
			return { ok: false, error: "subscription_item:" + type(raw) + ":" + sprintf("%J", raw) };
		}
	}

	let cursor = uci.cursor();
	stage = "tachyon_branch";
	if (product == "tachyon" && length(subscriptions) > 0)
		return apply_tachyon_subscription(section, subscriptions, args);
	stage = "generic";
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
		cursor.set(product, sub.name, "name", sub.label != "" ? sub.label : sub.name);
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
	} catch (e) {
		return { ok: false, error: "apply_connections_" + stage + ": " + e.message };
	}
}

return { precheck, verify, service_action, reload, apply_uci, apply_connections, cleanup_json_outbounds, restore_section_options, capture_product_config, apply_product_config, list_connections, manage_connection, delete_section, set_podkop_outbound, select_proxy, read_rules, migrate_legacy_tachyon_subscriptions, migrate_tachyon_lists };
