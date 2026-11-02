// RoutX: сбор управляемого состояния UCI (только allowlist).
const fs = require("fs");
const uci = require("uci");
const util = require("jn_util");
const allow = require("jn_allowlist");
const platform = require("jn_platform");

function load_config(cursor, config) {
	if (!cursor)
		cursor = uci.cursor();
	let all = cursor.get_all(config);
	return type(all) == "object" ? all : {};
}

function is_section(obj) {
	return type(obj) == "object" && obj[".type"] != null;
}

function read_state(product) {
	let cursor = uci.cursor();
	let managed = {};
	let config = product == "forkop" ? "forkop" : (product == "prokop" ? "prokop" : null);
	if (config == null)
		return { managed: {}, state_hash: util.sha256_hex(util.canonical_json({})) };

	let settings = cursor.get_all(config, "settings");
	if (type(settings) == "object") {
		for (let option in settings) {
			if (substr(option, 0, 1) == ".")
				continue;
			let path = "settings." + option;
			let rule = allow.classify_path(path);
			if (!rule.allowed)
				continue;
			let value = allow.read_value(settings[option], rule.list);
			if (value == null)
				continue;
			managed[path] = value;
		}
	}

	let all = load_config(cursor, config);
	for (let sname in all) {
		let sect = all[sname];
		if (!is_section(sect))
			continue;
		let stype = sect[".type"];
		if (stype != "section" && stype != "urltest" && stype != "section_interface" && stype != "subscription_url")
			continue;
		if (allow.FORBIDDEN_TYPES[stype])
			continue;

		let secname = sect[".name"];
		if (secname == null || secname == "")
			secname = sname;
		if (match(secname, /^[A-Za-z0-9_.-]{1,64}$/) == null)
			continue;

		for (let option in sect) {
			if (substr(option, 0, 1) == ".")
				continue;
			let path = stype + "." + secname + "." + option;
			let rule = allow.classify_path(path);
			if (!rule.allowed)
				continue;
			let value = allow.read_value(sect[option], rule.list);
			if (value == null)
				continue;
			managed[path] = value;
		}

		// Метаданные подписки без секрета: только хост и последние 4 символа.
		// Нужны панели, чтобы показать внешние подписки, не раскрывая URL.
		if (stype == "subscription_url") {
			let url = util.as_string(sect.url);
			if (url != "") {
				if (length(url) > 4)
					managed["subscription_url." + secname + ".url_tail"] = substr(url, length(url) - 4);
				let scheme = index(url, "://");
				let rest = scheme >= 0 ? substr(url, scheme + 3) : url;
				let stop = length(rest);
				for (let sep in [ "/", "?", "#" ]) {
					let pos = index(rest, sep);
					if (pos >= 0 && pos < stop)
						stop = pos;
				}
				let host = substr(rest, 0, stop);
				let at = rindex(host, "@");
				if (at >= 0)
					host = substr(host, at + 1);
				if (host != "")
					managed["subscription_url." + secname + ".url_host"] = host;
			}
		}
	}

	let state_hash = util.sha256_hex(util.canonical_json(managed));
	return { managed: managed, state_hash: state_hash };
}

function build_read_state(product) {
	let ui = platform.get_ui_state(product);
	let ui_vals = platform.ui_state_values(product, ui);
	let caps = platform.capability_view(product);
	let rs = read_state(product);
	let sb = platform.sing_box_info(product);

	return {
		managed: rs.managed,
		state_hash: rs.state_hash,
		health: {
			overall: ui_vals.health.overall,
			product_running: ui_vals.health.product_running,
			product_enabled: ui_vals.health.product_enabled,
			sing_box_running: ui_vals.health.sing_box_running,
			sing_box_enabled: ui_vals.health.sing_box_enabled,
			dns_configured: ui_vals.health.dns_configured,
			state_available: ui_vals.health.state_available
		},
		service: ui_vals.service,
		capabilities: caps
	};
}

return { load_config, read_state, build_read_state };
