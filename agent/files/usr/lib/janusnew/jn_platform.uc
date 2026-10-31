// JanusNew: определение продукта и платформы, чтение штатного UI-состояния.
// Никаких изменений здесь нет — только чтение.

const fs = require("fs");
const uci = require("uci");
const util = require("jn_util");
const run = require("jn_run");

const SUPPORTED_ARCH = {
	"aarch64_cortex-a53": true,
	"aarch64_generic": true
};

const PRODUCTS = ["forkop", "prokop"];

function release_info() {
	let text = util.read_file("/etc/openwrt_release", "");
	let info = {};
	for (let line in split(text, "\n")) {
		let idx = index(line, "=");
		if (idx <= 0)
			continue;
		let key = trim(substr(line, 0, idx));
		let value = trim(substr(line, idx + 1));
		if (length(value) >= 2) {
			let first = substr(value, 0, 1);
			let last = substr(value, length(value) - 1, 1);
			if ((first == "'" && last == "'") || (first == "\"" && last == "\""))
				value = substr(value, 1, length(value) - 2);
		}
		info[key] = value;
	}
	return info;
}

function openwrt_version() {
	let info = release_info();
	return util.as_string(info.DISTRIB_RELEASE);
}

function arch() {
	let info = release_info();
	return util.as_string(info.DISTRIB_ARCH);
}

function target() {
	let info = release_info();
	return util.as_string(info.DISTRIB_TARGET);
}

function model() {
	if (!util.file_exists("/tmp/sysinfo/model"))
		return "";
	return trim(util.read_file("/tmp/sysinfo/model", ""));
}

function supported_arch(value) {
	return SUPPORTED_ARCH[util.as_string(value)] === true;
}

function supported_openwrt(value) {
	let m = match(util.as_string(value), /^([0-9]+)\.([0-9]+)/);
	if (m == null)
		return false;
	let major = int(m[1]);
	let minor = int(m[2]);
	if (major > 24)
		return true;
	return major == 24 && minor >= 10;
}

function product_config(product) {
	return "/etc/config/" + product;
}

function product_binary(product) {
	return "/usr/bin/" + product;
}

function product_installed(product) {
	if (util.file_exists(product_config(product)) || util.file_exists(product_binary(product)))
		return true;
	if (util.file_exists("/etc/init.d/" + product))
		return true;

	// Бинарник и конфиг могут отсутствовать при частично снятом пакете.
	// Список пакетов — последняя проверка, чтобы не устанавливать второй продукт.
	let list = run.run([ "opkg", "list-installed" ], 20);
	if (list.ok) {
		let prefix = product + " ";
		for (let line in split(list.stdout, "\n")) {
			if (substr(trim(line), 0, length(prefix)) == prefix)
				return true;
		}
		return false;
	}
	let apk = run.run([ "apk", "info", "-e", product ], 10);
	return apk.ok;
}

function detect_product() {
	let has_forkop = product_installed("forkop");
	let has_prokop = product_installed("prokop");
	if (has_forkop && has_prokop)
		return "conflict";
	if (has_prokop)
		return "prokop";
	if (has_forkop)
		return "forkop";
	return "unknown";
}

function product_version(product) {
	if (product != "forkop" && product != "prokop")
		return "";
	let result = run.run_product(product, ["show_version"], 15);
	if (!result.ok)
		return "";
	return run.first_line(result.stdout);
}

function sing_box_info(product) {
	let version = "";
	let variant = "";

	if (product == "forkop" || product == "prokop") {
		let result = run.run_product(product, ["show_sing_box_version"], 15);
		if (result.ok)
			version = run.first_line(result.stdout);
	}

	if (version == "" && util.file_exists("/usr/bin/sing-box")) {
		let result = run.run(["/usr/bin/sing-box", "version"], 10);
		if (result.ok) {
			let m = match(result.stdout, /version[ \t]+([^ \t\r\n]+)/);
			if (m != null)
				version = m[1];
		}
	}

	for (let base in ["/etc/", "/var/run/"]) {
		if (version != "")
			break;
		if (product == "unknown")
			break;
		let path = base + product + "/sing-box-version";
		if (util.file_exists(path))
			version = run.first_line(util.read_file(path, ""));
	}

	if (product == "forkop" || product == "prokop") {
		let marker = util.read_file("/etc/" + product + "/sing-box-variant", "");
		if (trim(marker) != "")
			variant = run.first_line(marker);
	}
	if (variant == "" && index(version, "extended") >= 0)
		variant = index(version, "compressed") >= 0 ? "extended_compressed" : "extended";

	return { version: version, variant: variant };
}

function manifest_version(product) {
	if (product != "forkop" && product != "prokop")
		return null;
	let cursor = uci.cursor();
	let value = cursor.get(product, "settings", "config_version");
	if (value == null)
		return null;
	let number = int(value);
	return number == null ? null : number;
}

function platform_state(product) {
	if (product == "conflict")
		return "conflict";
	if (!supported_openwrt(openwrt_version()) || !supported_arch(arch()))
		return "unsupported";
	return "ok";
}

function get_ui_state(product) {
	if (product != "forkop" && product != "prokop")
		return null;
	let result = run.run_product(product, ["get_ui_state"], 20);
	if (!result.ok)
		return null;
	let parsed = util.json_parse(result.stdout);
	return type(parsed) == "object" ? parsed : null;
}

function ui_state_values(product, ui) {
	let service = {};
	let capabilities = {};
	if (type(ui) == "object") {
		if (type(ui.service) == "object")
			service = ui.service;
		if (type(ui.capabilities) == "object")
			capabilities = ui.capabilities;
	}

	let own = (product == "forkop" || product == "prokop") && type(service[product]) == "object"
		? service[product] : {};
	let sing_box = type(service.sing_box) == "object" ? service.sing_box : {};
	let present = length(keys(service)) > 0;

	let product_running = util.is_true(own.running);
	let product_enabled = util.is_true(own.enabled);
	let sing_box_running = util.is_true(sing_box.running);
	let sing_box_enabled = util.is_true(sing_box.enabled);
	let dns_configured = util.is_true(own.dns_configured);
	// Prokop/Forkop сами запускают sing-box и штатно отключают его standalone
	// автозапуск. Для них выключенный /etc/rc.d/S99sing-box — норма, если
	// продукт включён и запущен.
	let sing_box_managed = (product == "forkop" || product == "prokop") &&
		product_running && product_enabled;
	let sing_box_autostart_ok = sing_box_enabled || sing_box_managed;

	let overall = "unknown";
	if (present) {
		if (!product_running && !sing_box_running)
			overall = "stopped";
		else if (!product_running || !sing_box_running || !product_enabled || !sing_box_autostart_ok)
			overall = "degraded";
		else
			overall = "ok";
	}

	return {
		service: service,
		capabilities: capabilities,
		health: {
			overall: overall,
			product_running: product_running,
			product_enabled: product_enabled,
			sing_box_running: sing_box_running,
			sing_box_enabled: sing_box_enabled,
			sing_box_managed: sing_box_managed,
			sing_box_autostart_ok: sing_box_autostart_ok,
			dns_configured: dns_configured,
			state_available: present
		}
	};
}

function capability_view(product) {
	let platform = platform_state(product);
	let writable = platform == "ok" && (product == "forkop" || product == "prokop");
	return {
		product: product,
		readonly: !writable,
		write_reason: writable ? null : (platform == "conflict" ? "product_conflict"
			: platform == "unsupported" ? "unsupported_platform" : "product_unknown"),
		snapshots: product == "prokop" ? "native" : (product == "forkop" ? "local" : "none"),
		sing_box: product == "forkop" || product == "prokop",
		proxy_health: true,
		diagnostics: true,
		service_actions: ["restart", "start", "stop", "enable", "disable"],
		uci_allowlist: true
	};
}

return {
	SUPPORTED_ARCH, PRODUCTS,
	release_info, openwrt_version, arch, target, model,
	supported_arch, supported_openwrt,
	product_config, product_binary, detect_product, product_version,
	sing_box_info, manifest_version, platform_state, get_ui_state,
	ui_state_values, capability_view
};
