// RoutX: точная копия allowlist сервера RoutX.
// Любой путь, которого нет здесь, агентом отвергается (fail closed).
// Секретные параметры запрещены до любых операций записи.

function set_of(values) {
	let out = {};
	for (let value in values)
		out[value] = true;
	return out;
}

const SETTINGS_OPTIONS = set_of([
	"dns_type", "dns_server", "bootstrap_dns_server", "dns_strategy",
	"dns_check_interval", "dns_failover_failure_threshold", "dns_rewrite_ttl",
	"dns_detour_enabled", "dns_detour_section", "source_network_interfaces",
	"enable_output_network_interface", "output_network_interface",
	"enable_badwan_interface_monitoring", "badwan_monitored_interfaces",
	"badwan_reload_delay", "dont_touch_dhcp", "log_level", "exclude_ntp",
	"intercept_client_dns", "tproxy_low_memory", "nfqws_first_packets",
	"list_update_enabled", "update_interval", "component_update_check_enabled",
	"component_update_check_interval", "disable_quic", "latency_test_url",
	"download_lists_via_proxy", "device_traffic", "exclude_bittorrent"
]);

const SETTINGS_LIST_OPTIONS = set_of([
	"dns_server", "bootstrap_dns_server", "source_network_interfaces",
	"badwan_monitored_interfaces"
]);

const SECTION_OPTIONS = set_of([
	"label", "enabled", "action", "dns_type", "dns_server",
	"dns_detour_enabled", "dns_detour_section",
	"community_lists", "rule_set",
	"rule_set_with_subnets", "fully_routed_ips", "excluded_source_ip_cidr",
	"domain", "domain_suffix", "domain_keyword", "domain_regex",
	"domain_ip_lists", "remote_domain_lists", "remote_subnet_lists",
	"outbound_detour_enabled", "outbound_detour_section", "sort_by_latency",
	// Podkop: тип секции и параметры прокси/маршрутизации.
	"connection_type", "proxy_config_type", "interface",
	"user_domain_list_type", "user_domains", "user_domains_text",
	"user_subnet_list_type", "user_subnets", "user_subnets_text",
	"local_domain_lists", "local_subnet_lists",
	"enable_udp_over_tcp", "urltest_check_interval", "urltest_tolerance",
	"urltest_testing_url", "mixed_proxy_enabled", "mixed_proxy_port",
	"domain_resolver_enabled", "resolve_real_ip_for_routing"
]);

const SECTION_LIST_OPTIONS = set_of([
	"community_lists", "rule_set", "rule_set_with_subnets", "fully_routed_ips",
	"excluded_source_ip_cidr", "domain_suffix", "domain_keyword",
	"domain_regex", "domain_ip_lists", "remote_domain_lists",
	"remote_subnet_lists",
	// Podkop: списки доменов, подсетей и правил.
	"user_domains", "user_subnets", "local_domain_lists", "local_subnet_lists"
]);

const URLTEST_OPTIONS = set_of([
	"section", "name", "check_interval", "tolerance", "testing_url",
	"idle_timeout", "interrupt_exist_connections", "pin_dashboard",
	"filter_mode", "detect_server_country", "exclude_countries",
	"exclude_outbounds", "exclude_regex", "include_countries",
	"include_outbounds", "include_regex"
]);

const URLTEST_LIST_OPTIONS = set_of([
	"exclude_countries", "exclude_outbounds", "include_countries",
	"include_outbounds"
]);

const SECTION_INTERFACE_OPTIONS = set_of([
	"name", "domain_resolver_enabled", "domain_resolver_dns_type",
	"domain_resolver_dns_server"
]);

const SECTION_INTERFACE_LIST_OPTIONS = set_of(["domain_resolver_dns_server"]);

const SUBSCRIPTION_OPTIONS = set_of([
	"section", "user_agent", "subscription_update_enabled",
	"subscription_update_interval", "download_via_proxy_enabled",
	"show_dashboard_metadata", "prefix_nodes", "node_prefix",
	"include_urltest_groups", "url_tail", "url_host"
]);

const FORBIDDEN_TYPES = set_of(["server"]);

const SECRET_OPTIONS = set_of([
	"selector_proxy_links", "urltest_proxy_links", "urltest_fallback_links",
	"proxy_string", "outbound_jsons", "outbound_json", "url"
]);

const SECRET_PATTERN = /(selector_proxy|outbound_json|private[_-]?key|password|passwd|secret|token|api[_-]?key|subscription.*url|^url$|auth)/i;

const HARD_EXCLUDED_SETTINGS = set_of([
	"config_version", "applied_migrations", "mirror_base_url",
	"sing_box_pinned_version", "enable_yacd", "config_path", "cache_path"
]);

const HARD_EXCLUDED_PREFIXES = ["direct_proxy_", "torrserver_"];

const SECTION_TYPES = set_of(["section", "urltest", "section_interface", "subscription_url"]);

const SECTION_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function is_hard_excluded(option) {
	if (HARD_EXCLUDED_SETTINGS[option])
		return true;
	for (let prefix in HARD_EXCLUDED_PREFIXES)
		if (substr(option, 0, length(prefix)) == prefix)
			return true;
	return false;
}

function parse_path(path) {
	if (type(path) != "string" || length(path) > 160)
		return null;
	let parts = split(path, ".");
	if (length(parts) == 2 && parts[0] == "settings")
		return { type: "settings", option: parts[1] };
	if (length(parts) == 3) {
		if (match(parts[1], SECTION_RE) == null)
			return null;
		if (!SECTION_TYPES[parts[0]])
			return null;
		return { type: parts[0], section: parts[1], option: parts[2] };
	}
	return null;
}

function rule(allowed, list, reason) {
	return { allowed, list, reason: reason };
}

function classify_path(path) {
	let parsed = parse_path(path);
	if (parsed == null)
		return rule(false, false, "invalid_path");
	if (FORBIDDEN_TYPES[parsed.type])
		return rule(false, false, "forbidden_type");
	if (SECRET_OPTIONS[parsed.option] || match(parsed.option, SECRET_PATTERN) != null)
		return rule(false, false, "secret_path");

	if (parsed.type == "settings") {
		if (is_hard_excluded(parsed.option))
			return rule(false, false, "hard_excluded");
		if (!SETTINGS_OPTIONS[parsed.option])
			return rule(false, false, "not_in_allowlist");
		return rule(true, SETTINGS_LIST_OPTIONS[parsed.option] === true, null);
	}
	if (parsed.type == "section") {
		if (!SECTION_OPTIONS[parsed.option])
			return rule(false, false, "not_in_allowlist");
		return rule(true, SECTION_LIST_OPTIONS[parsed.option] === true, null);
	}
	if (parsed.type == "urltest") {
		if (!URLTEST_OPTIONS[parsed.option])
			return rule(false, false, "not_in_allowlist");
		return rule(true, URLTEST_LIST_OPTIONS[parsed.option] === true, null);
	}
	if (parsed.type == "section_interface") {
		if (!SECTION_INTERFACE_OPTIONS[parsed.option])
			return rule(false, false, "not_in_allowlist");
		return rule(true, SECTION_INTERFACE_LIST_OPTIONS[parsed.option] === true, null);
	}
	if (parsed.type == "subscription_url") {
		if (!SUBSCRIPTION_OPTIONS[parsed.option])
			return rule(false, false, "not_in_allowlist");
		return rule(true, false, null);
	}
	return rule(false, false, "unsupported_path");
}

function normalize_value(value, is_list) {
	if (value == null)
		return { ok: true, value: null };

	if (is_list) {
		let out = [];
		if (type(value) == "array") {
			for (let item in value) {
				let text = trim("" + item);
				if (text != "")
					push(out, text);
			}
		}
		else {
			for (let item in split("" + value, "\n")) {
				let text = trim(item);
				if (text != "")
					push(out, text);
			}
		}
		out = slice(out, 0, 5000);
		return { ok: true, value: length(out) == 0 ? null : out };
	}

	if (type(value) == "array") {
		if (length(value) > 1)
			return { ok: false, error: "value_not_list" };
		if (length(value) == 0)
			return { ok: true, value: null };
		return { ok: true, value: "" + value[0] };
	}
	return { ok: true, value: "" + value };
}

// Значение, прочитанное из UCI. Пустой список считается отсутствующим,
// чтобы хэш состояния совпадал с состоянием после удаления параметра.
function read_value(value, is_list) {
	if (value == null)
		return null;
	if (type(value) == "array") {
		let out = [];
		for (let item in value) {
			let text = "" + item;
			if (text != "")
				push(out, text);
		}
		return length(out) == 0 ? null : out;
	}
	if (is_list) {
		let text = "" + value;
		return text == "" ? null : [text];
	}
	return "" + value;
}

return {
	SETTINGS_OPTIONS, SETTINGS_LIST_OPTIONS, SECTION_OPTIONS,
	SECTION_LIST_OPTIONS, URLTEST_OPTIONS, URLTEST_LIST_OPTIONS,
	SECTION_INTERFACE_OPTIONS, SECTION_INTERFACE_LIST_OPTIONS,
	SUBSCRIPTION_OPTIONS, FORBIDDEN_TYPES, SECTION_TYPES,
	classify_path, parse_path, normalize_value, read_value
};
