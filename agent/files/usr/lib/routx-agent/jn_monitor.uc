// RoutX: мониторинг прокси через штатный Clash API Prokop/Forkop.
// Секреты Clash API не читаются и не передаются: CLI продукта сам делает
// запросы, а наружу уходят только задержки и количество живых тегов.
const fs = require("fs");
const uci = require("uci");
const util = require("jn_util");
const run = require("jn_run");
const product_api = require("jn_product_api");

const OUTBOUND_ACTIONS = {
	connection: true,
	proxy: true,
	outbound: true,
	vpn: true
};

const ACTIVE_TEST_TTL = 180; // секунд между активными замерами одной группы
const MAX_ACTIVE_TAGS = 30;
const ACTIVE_TEST_TIMEOUT_MS = "2500";
const IP_CHECK_TTL = 300; // публичные IP меняются редко; не дёргаем сеть каждый опрос
const IPCHECK_DIR = "/var/run/routx-agent/ipcheck";

let active_cache = {};
let ip_cache = { at: 0, direct: "", vpn: "" };

function cli(product, args, timeout) {
	let res = run.run_product(product, args, timeout);
	if (!res.ok)
		return { ok: false, error: run.error_text(res) };
	let value = util.json_parse(res.stdout);
	if (type(value) != "object")
		return { ok: false, error: "invalid_json" };
	return { ok: true, value: value };
}

function enabled_sections(product) {
	let names = {};
	let cursor = uci.cursor();
	let all = cursor.get_all(product);
	if (type(all) != "object")
		return names;
	for (let sname in all) {
		let sect = all[sname];
		if (type(sect) != "object" || sect[".type"] != "section")
			continue;
		if (util.as_string(sect.enabled) == "0")
			continue;
		if (product == "podkop") {
			let kind = util.as_string(sect.connection_type);
			if (kind != "proxy" && kind != "vpn")
				continue;
		} else if (!OUTBOUND_ACTIONS[util.as_string(sect.action)]) {
			continue;
		}
		let name = util.as_string(sect[".name"]);
		names[name == "" ? sname : name] = true;
		let label = trim(util.as_string(sect.label));
		if (label != "")
			names[label] = true;
	}
	return names;
}

function is_group(proxy) {
	if (type(proxy) != "object")
		return false;
	let kind = lc(util.as_string(proxy.type));
	return kind == "selector" || kind == "urltest" || kind == "fallback";
}

function pick_single(proxies, sections) {
	if (type(proxies) != "object")
		return "";
	for (let section in sections) {
		let tag = section + "-out";
		let proxy = proxies[tag];
		if (type(proxy) == "object" && !is_group(proxy))
			return tag;
	}
	return "";
}

function pick_group(proxies, sections) {
	if (type(proxies) != "object")
		return "";
	let fallback = "";
	for (let tag, proxy in proxies) {
		if (!is_group(proxy))
			continue;
		// Forkop 2.x называет группу секции её label; старые версии — <section>-out.
		if (sections[tag] === true)
			return tag;
		if (length(tag) <= 4 || substr(tag, length(tag) - 4) != "-out")
			continue;
		let section = substr(tag, 0, length(tag) - 4);
		if (sections[section] === true)
			return tag;
		if (fallback == "")
			fallback = tag;
	}
	return fallback;
}

function measured(value) {
	return (type(value) == "int" || type(value) == "double") && value > 0;
}

function median(values) {
	if (length(values) == 0)
		return null;
	let items = [];
	for (let value in values)
		push(items, value);
	for (let i = 1; i < length(items); i++) {
		let item = items[i];
		let j = i - 1;
		while (j >= 0 && items[j] > item) {
			items[j + 1] = items[j];
			j--;
		}
		items[j + 1] = item;
	}
	return items[int(length(items) / 2)];
}

function last_history_delay(proxy) {
	if (type(proxy) != "object" || type(proxy.history) != "array")
		return null;
	for (let i = length(proxy.history) - 1; i >= 0; i--) {
		let item = proxy.history[i];
		if (type(item) == "object" && measured(item.delay))
			return item.delay;
	}
	return null;
}

// Активный замер группы: не чаще раза в ACTIVE_TEST_TTL секунд.
// Если группа большая или замер не удался, используем историю sing-box.
function active_delays(product, group, members, force) {
	let now = util.now_epoch();
	let cached = active_cache[group];
	if (!force && cached != null && now - cached.at < ACTIVE_TEST_TTL)
		return { ok: true, delays: cached.delays };

	if (length(members) > MAX_ACTIVE_TAGS)
		return { ok: false, error: "group_too_large" };

	let res = product_api.group_latency(product, group, ACTIVE_TEST_TIMEOUT_MS);
	if (!res.ok || res.value.success === false)
		return { ok: false, error: res.ok ? util.as_string(res.value.error) : res.error };

	let delays = {};
	for (let tag in members) {
		let value = res.value[tag];
		if (measured(value))
			delays[tag] = value;
	}
	active_cache[group] = { at: now, delays: delays };
	return { ok: true, delays: delays };
}

// Prokop/Forkop называют outbound-группу по физическому имени UCI-секции:
// gga -> gga-out. Пользователь видит label (router_control), поэтому в
// человекочитаемых сообщениях показываем label, а не внутренний тег.
function group_display(product, group) {
	let cursor = uci.cursor();
	// Forkop 2.x: тег группы — это label секции.
	let all = cursor.get_all(product);
	if (type(all) == "object") {
		for (let sname in all) {
			let sect = all[sname];
			if (type(sect) != "object" || sect[".type"] != "section")
				continue;
			if (trim(util.as_string(sect.label)) == group)
				return group;
		}
	}
	let name = group;
	let dash = rindex(group, "-");
	if (dash > 0) {
		let candidate = substr(group, 0, dash);
		if (cursor.get(product, candidate) == "section") {
			let label = util.as_string(cursor.get(product, candidate, "label"));
			if (label != "")
				return label;
			return candidate;
		}
	}
	if (cursor.get(product, group) == "section") {
		let label = util.as_string(cursor.get(product, group, "label"));
		if (label != "")
			return label;
	}
	return group;
}

function probe_proxy(product, force) {
	let result = {
		proxy_health: "unknown",
		latency_ms: null,
		failed_tags: null,
		total_tags: null,
		detail: ""
	};

	let proxies = product_api.get_proxies(product, 20);
	if (!proxies.ok || type(proxies.value.proxies) != "object") {
		result.detail = "Clash API недоступен";
		return result;
	}

	let sections = enabled_sections(product);
	let group = pick_group(proxies.value.proxies, sections);
	if (group == "") {
		let single = pick_single(proxies.value.proxies, sections);
		if (single == "") {
			result.detail = "нет группы прокси";
			return result;
		}
		let res = product_api.proxy_latency(product, single, "5000");
		let delay = res.ok && res.value.success !== false && measured(res.value.delay)
			? res.value.delay : null;
		result.total_tags = 1;
		result.failed_tags = delay == null ? 1 : 0;
		result.latency_ms = delay;
		result.proxy_health = delay == null ? "dead" : "healthy";
		result.detail = "подключение " + group_display(product, single) +
			(delay == null ? ": не отвечает" : ": " + delay + " мс");
		return result;
	}
	let display_group = group_display(product, group);

	let info = proxies.value.proxies[group];
	let members = type(info) == "object" && type(info.all) == "array" ? info.all : [];
	if (length(members) == 0) {
		result.detail = "группа " + display_group + " пуста";
		return result;
	}

	let active = active_delays(product, group, members, force);
	if (!active.ok && active.error == "latency_failed") {
		result.proxy_health = "dead";
		result.total_tags = length(members);
		result.failed_tags = length(members);
		result.detail = "группа " + display_group + ": ни один тег не ответил";
		return result;
	}
	let delays = active.ok ? active.delays : {};
	let use_history = !active.ok;

	let alive = 0;
	let failed = 0;
	let latencies = [];
	let failed_names = [];
	for (let tag in members) {
		let delay = delays[tag];
		if (!measured(delay) && use_history)
			delay = last_history_delay(proxies.value.proxies[tag]);
		if (measured(delay)) {
			alive++;
			push(latencies, delay);
		}
		else {
			failed++;
			push(failed_names, util.as_string(tag));
		}
	}

	result.total_tags = length(members);
	result.failed_tags = failed;
	// Показываем задержку активного сервера, а не медиану всех тегов.
	let active_tag = type(info) == "object" ? util.as_string(info.now) : "";
	let active_delay = active_tag != "" ? delays[active_tag] : null;
	result.latency_ms = measured(active_delay) ? active_delay : median(latencies);
	result.detail = "группа " + display_group + ": " + alive + "/" + length(members) + " живых";
	if (failed > 0 && length(failed_names) <= 3)
		result.detail = result.detail + " (" + join(", ", failed_names) + ")";

	if (alive == 0)
		result.proxy_health = "dead";
	else if (failed > 0)
		result.proxy_health = "degraded";
	else
		result.proxy_health = "healthy";

	return result;
}

function valid_ip(value) {
	if (match(value, /^(\d{1,3}\.){3}\d{1,3}$/) != null) {
		for (let part in split(value, ".")) {
			if (int(part) > 255)
				return false;
		}
		return true;
	}
	return index(value, ":") > 0 && match(value, /^[0-9a-f:]+$/i) != null;
}

function load_sing_box_config() {
	let paths = [
		"/etc/sing-box/config.json",
		"/etc/forkop/sing-box/config.json",
		"/etc/prokop/sing-box/config.json"
	];
	for (let path in paths) {
		if (!util.file_exists(path))
			continue;
		try {
			let cfg = json(fs.readfile(path));
			if (type(cfg) == "object")
				return cfg;
		}
		catch (e) {
		}
	}
	return null;
}

function has_outbound(cfg, tag) {
	for (let out in (type(cfg.outbounds) == "array" ? cfg.outbounds : [])) {
		if (util.as_string(out.tag) == tag)
			return true;
	}
	return false;
}

function vpn_outbound(cfg) {
	let tag = "";
	for (let rule in (cfg.route && type(cfg.route.rules) == "array" ? cfg.route.rules : [])) {
		if (type(rule.domain) != "array")
			continue;
		for (let domain in rule.domain) {
			if (domain == "ip.podkop.fyi" && rule.outbound)
				tag = rule.outbound;
		}
	}
	if (tag != "")
		return tag;
	for (let out in (type(cfg.outbounds) == "array" ? cfg.outbounds : [])) {
		let name = util.as_string(out.tag);
		if (length(name) > 4 && substr(name, length(name) - 4) == "-out")
			tag = name;
	}
	return tag;
}

function write_ipcheck_config(cfg) {
	cfg.inbounds = [];
	cfg.services = [];
	if (type(cfg.experimental) == "object") {
		delete cfg.experimental.clash_api;
		if (type(cfg.experimental.cache_file) == "object")
			cfg.experimental.cache_file.path = IPCHECK_DIR + "/cache.db";
	}
	util.mkdir_p(IPCHECK_DIR, 0700);
	let fh = fs.open(IPCHECK_DIR + "/config.json", "w", 0600);
	if (fh == null)
		return false;
	fh.write(sprintf("%J\n", cfg));
	fh.close();
	return true;
}

function fetch_ip(tag) {
	let res = run.run([
		"/usr/bin/sing-box", "tools", "fetch", "api.ipify.org",
		"-c", IPCHECK_DIR + "/config.json", "-D", IPCHECK_DIR,
		"-o", tag, "--disable-color"
	], 20);
	if (!res.ok)
		return "";
	let value = trim(util.as_string(res.stdout));
	return valid_ip(value) ? value : "";
}

// Публичный IP напрямую и через VPN. Конфиг sing-box копируется во временный
// каталог 0700, потому что в нём есть секреты; после проверки он удаляется.
function current_ips(product, force) {
	let now = util.now_epoch();
	if (!force && ip_cache.at > 0 && now - ip_cache.at < IP_CHECK_TTL)
		return ip_cache;

	let cfg = load_sing_box_config();
	if (cfg == null) {
		ip_cache = { at: now, direct: "", vpn: "" };
		return ip_cache;
	}
	let direct_tag = has_outbound(cfg, "direct-out") ? "direct-out"
		: (has_outbound(cfg, "bypass-out") ? "bypass-out" : "");
	let vpn_tag = vpn_outbound(cfg);
	let direct = "";
	let vpn = "";

	if (write_ipcheck_config(cfg)) {
		if (direct_tag != "")
			direct = fetch_ip(direct_tag);
		// Forkop 2.x умеет отдавать exit-IP через Clash API. Это надёжнее,
		// чем запуск второго sing-box: адрес точно соответствует выбранному серверу.
		if (product_api.is_forkop_v2(product)) {
			let proxies = product_api.get_proxies(product, 20);
			if (proxies.ok && type(proxies.value.proxies) == "object") {
				let group = pick_group(proxies.value.proxies, enabled_sections(product));
				let info = group != "" ? proxies.value.proxies[group] : null;
				let active = type(info) == "object" ? util.as_string(info.now) : "";
				if (active != "") {
					let exit = product_api.proxy_exit_ip(product, active, "5000");
					if (exit.ok && exit.ip != "")
						vpn = exit.ip;
				}
			}
		}
		if (vpn == "" && vpn_tag != "")
			vpn = fetch_ip(vpn_tag);
		run.run([ "rm", "-rf", IPCHECK_DIR ], 5);
	}

	ip_cache = { at: now, direct: direct, vpn: vpn };
	return ip_cache;
}

// Проверка доступности нескольких сайтов через активный VPN-сервер.
// Возвращает результат по каждому адресу; один недоступный сайт не ломает
// проверку остальных.
function site_probe(product, targets) {
	let urls = [];
	let seen = {};
	for (let raw in (type(targets) == "array" ? targets : [])) {
		let target = trim(util.as_string(raw));
		if (target == "" || match(target, /^https?:\/\/[^ \t\r\n]+$/) == null)
			continue;
		if (seen[target] === true || length(urls) >= 8)
			continue;
		seen[target] = true;
		push(urls, target);
	}
	if (length(urls) == 0)
		return { ok: false, error: "no_targets", message: "Нет адресов для проверки" };

	let results = [];
	let proxies = product_api.get_proxies(product, 20);
	let tag = "";
	if (proxies.ok && type(proxies.value.proxies) == "object") {
		let group = pick_group(proxies.value.proxies, enabled_sections(product));
		let info = group != "" ? proxies.value.proxies[group] : null;
		tag = type(info) == "object" ? util.as_string(info.now) : "";
	}

	for (let target in urls) {
		if (tag == "") {
			push(results, { target: target, ok: false, latency_ms: null, error: "vpn_unavailable" });
			continue;
		}
		let res = product_api.proxy_latency(product, tag, "5000", target);
		if (res.ok && res.value.success !== false && measured(res.value.delay))
			push(results, { target: target, ok: true, latency_ms: res.value.delay });
		else
			push(results, {
				target: target,
				ok: false,
				latency_ms: null,
				error: res.ok ? util.as_string(res.value.error) : res.error
			});
	}

	return { ok: true, results: results };
}

function access_check(product, target) {
	target = trim(util.as_string(target));
	if (target == "")
		target = "https://www.youtube.com/generate_204";
	if (match(target, /^https?:\/\/[^ \t\r\n]+$/) == null)
		return { ok: false, error: "invalid_target", message: "Некорректный адрес проверки" };

	let proxies = product_api.get_proxies(product, 20);
	if (!proxies.ok || type(proxies.value.proxies) != "object")
		return { ok: false, error: "clash_api_unavailable", message: "Clash API недоступен" };

	let sections = enabled_sections(product);
	let group = pick_group(proxies.value.proxies, sections);
	if (group == "")
		return { ok: false, error: "no_proxy_group", message: "На роутере нет группы прокси" };

	let info = proxies.value.proxies[group];
	let tag = type(info) == "object" ? util.as_string(info.now) : "";
	if (tag == "")
		return { ok: false, error: "no_active_proxy", message: "Не выбран активный прокси" };

	let res = product_api.proxy_latency(product, tag, "5000", target);
	if (!res.ok)
		return { ok: false, error: "proxy_check_failed", message: res.error };
	if (res.value.success === false) {
		return {
			ok: false,
			error: util.as_string(res.value.error) || "access_failed",
			message: util.as_string(res.value.message) || "Запрос через прокси не прошёл"
		};
	}
	if (!measured(res.value.delay))
		return { ok: false, error: "access_failed", message: "Прокси не вернул задержку" };

	return {
		ok: true,
		target: target,
		group: group,
		proxy_tag: tag,
		latency_ms: res.value.delay
	};
}

function probe(product, force) {
	let result = {
		reachable: true,
		service_state: "",
		health: "",
		proxy_health: "unknown",
		latency_ms: null,
		failed_tags: null,
		total_tags: null,
		direct_ip: "",
		vpn_ip: "",
		detail: ""
	};

	// Роутер доступен уже потому, что агент выполнил эту команду.
	// health_status даёт состояние службы, а не только признак ответа.
	if (product == "podkop") {
		let status = cli(product, [ "get_status" ], 15);
		let sb = cli(product, [ "get_sing_box_status" ], 15);
		let running = sb.ok && int(sb.value.running) == 1;
		let enabled = status.ok && int(status.value.enabled) == 1;
		if (!running) {
			result.service_state = enabled ? "stopped but enabled" : "stopped & disabled";
			result.health = "failed";
		} else if (!enabled) {
			result.service_state = "running but disabled";
			result.health = "degraded";
		} else if (sb.ok && int(sb.value.dns_configured) != 1) {
			result.service_state = "running, DNS not configured";
			result.health = "degraded";
		} else {
			result.service_state = "running & enabled";
			result.health = "ok";
		}
	} else if (product_api.is_forkop_v2(product)) {
		let status = cli(product, [ "get_status" ], 15);
		if (!status.ok) {
			result.service_state = "unknown";
			result.health = "unknown";
		} else {
			let running = int(status.value.running) == 1;
			let enabled = int(status.value.enabled) == 1;
			result.service_state = util.as_string(status.value.status) ||
				(running ? "running" : "stopped");
			if (!running) {
				result.health = "failed";
			} else if (!enabled) {
				result.health = "degraded";
			} else {
				result.health = "ok";
				let checks = cli(product, [ "check_service" ], 20);
				if (checks.ok && type(checks.value.core) == "object") {
					let core = checks.value.core;
					if (core.installed !== true) {
						result.health = "degraded";
						result.service_state += ", ядро не установлено";
					} else if (util.as_string(core.problem) != "") {
						result.health = "degraded";
						result.service_state += ", " + util.as_string(core.problem);
					}
				}
			}
		}
	} else {
	let health = cli(product, [ "get_health_status" ], 20);
	if (health.ok) {
		result.service_state = util.as_string(health.value.overall);
		result.health = result.service_state;
	}

	// get_health_status считает общий health «ok», даже когда служба запущена,
	// но автозапуск выключен. Для мониторинга это важное отличие.
	let status = cli(product, [ "get_status" ], 15);
	if (status.ok) {
		let running = status.value.running === 1;
		let enabled = status.value.enabled === 1;
		if (!running) {
			result.service_state = util.as_string(status.value.status) || "stopped";
			result.health = "failed";
		}
		else if (!enabled) {
			result.service_state = util.as_string(status.value.status) || "running but disabled";
			result.health = "degraded";
		}
	}
	else if (result.health == "") {
		result.service_state = "unknown";
		result.health = "unknown";
	}
	}

	let proxy = probe_proxy(product, force);
	result.proxy_health = proxy.proxy_health;
	result.latency_ms = proxy.latency_ms;
	result.failed_tags = proxy.failed_tags;
	result.total_tags = proxy.total_tags;
	result.detail = proxy.detail;

	let ips = current_ips(product, force);
	result.direct_ip = ips.direct;
	result.vpn_ip = ips.vpn;

	return result;
}

return { probe, access_check, site_probe };
