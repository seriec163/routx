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

function podkop_value(value) {
	if (value == null)
		return null;
	if (type(value) == "array") {
		let out = [];
		for (let item in value) {
			let text = trim("" + item);
			if (text != "")
				push(out, text);
		}
		return length(out) == 0 ? null : out;
	}
	return "" + value;
}

// Podkop не имеет отдельного allowlist в RoutX: для панели читаем только
// несекретные опции секций и настроек. proxy_string/urltest_proxy_links/
// selector_proxy_links/outbound_json никогда не попадают в состояние.
const PODKOP_SECTION_OPTIONS = {
	enabled: true,
	connection_type: true, proxy_config_type: true, interface: true,
	community_lists: true, user_domain_list_type: true, user_domains: true,
	user_domains_text: true, user_subnet_list_type: true, user_subnets: true,
	user_subnets_text: true, local_domain_lists: true, local_subnet_lists: true,
	remote_domain_lists: true, remote_subnet_lists: true, fully_routed_ips: true,
	enable_udp_over_tcp: true, urltest_check_interval: true,
	urltest_tolerance: true, urltest_testing_url: true,
	mixed_proxy_enabled: true, mixed_proxy_port: true,
	domain_resolver_enabled: true, resolve_real_ip_for_routing: true
};

const PODKOP_SETTINGS_OPTIONS = {
	dns_type: true, dns_server: true, bootstrap_dns_server: true,
	disable_quic: true, update_interval: true, dont_touch_dhcp: true,
	exclude_ntp: true, log_level: true, source_network_interfaces: true
};

function read_podkop_state(cursor) {
	let managed = {};
	let all = cursor.get_all("podkop");
	if (type(all) == "object") {
		for (let sname in all) {
			let sect = all[sname];
			if (type(sect) != "object")
				continue;
			let stype = "" + sect[".type"];
			let secname = "" + sect[".name"];
			if (secname == "")
				secname = sname;
			if (stype == "settings") {
				for (let option in PODKOP_SETTINGS_OPTIONS) {
					let value = podkop_value(sect[option]);
					if (value != null)
						managed["settings." + option] = value;
				}
				continue;
			}
			if (stype != "section" && stype != "urltest")
				continue;
			if (match(secname, /^[A-Za-z0-9_.-]{1,64}$/) == null)
				continue;
			for (let option in PODKOP_SECTION_OPTIONS) {
				let value = podkop_value(sect[option]);
				if (value != null)
					managed["section." + secname + "." + option] = value;
			}
		}
	}
	let state_hash = util.sha256_hex(util.canonical_json(managed));
	return { managed: managed, state_hash: state_hash };
}

function read_state(product) {
	let cursor = uci.cursor();
	if (product == "podkop")
		return read_podkop_state(cursor);
	let managed = {};
	let config = product == "forkop" ? "forkop" : (product == "prokop" ? "prokop" : (product == "tachyon" ? "tachyon" : null));
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

return { load_config, read_state, build_read_state, read_podkop_state };
