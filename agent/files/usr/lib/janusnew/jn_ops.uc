// JanusNew: операции apply/precheck/reload/service/verify
const fs = require("fs");
const uci = require("uci");
const util = require("jn_util");
const allow = require("jn_allowlist");
const run = require("jn_run");
const state = require("jn_uci_state");

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

function reload(product) {
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
	if (product != "forkop" && product != "prokop")
		return { ok: false, error: "неизвестный продукт" };

	let current = state.read_state(product);
	if (util.as_string(base_state_hash) != "" && current.state_hash != util.as_string(base_state_hash)) {
		return { ok: false, error: "base_state_hash_mismatch", code: "base_state_hash_mismatch" };
	}

	let create = {};
	for (let name in (create_sections || []))
		create[util.as_string(name)] = true;

	let list_prefix = "/etc/janusnew/lists/";
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

const LINK_RE = /^(vless|vmess|trojan|ss|ssr|hysteria2?|tuic):\/\/\S+$/i;
const SUBSCRIPTION_RE = /^https?:\/\/\S+$/i;
const SECTION_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const CONNECTIONS_STATE = util.STATE_DIR + "/connections.json";

// Какие VLESS-ссылки в секции добавил Router Control. Нужно, чтобы при
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

function apply_connections(product, args) {
	if (product != "forkop" && product != "prokop")
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
		// Удаляем только те ссылки, которые Router Control добавил сам.
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
		label = "Router Control";

	let enabled = args.enabled == null ? true : util.is_true(args.enabled);
	cursor.set(product, section, "action", "connection");
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
	// записей Router Control. Если такая ссылка уже есть, не создаём дубликат.
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
	// что Router Control удалил свои подключения.
	if (!enabled && (length(merged_links) > 0 || foreign_subscriptions > 0))
		enabled = true;
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

return { precheck, verify, service_action, reload, apply_uci, apply_connections };
