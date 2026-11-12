// RoutX: определение продукта и платформы, чтение штатного UI-состояния.
// Никаких изменений здесь нет — только чтение.

const fs = require("fs");
const uci = require("uci");
const util = require("jn_util");
const run = require("jn_run");

const SUPPORTED_ARCH = {
	"aarch64_cortex-a53": true,
	"aarch64_generic": true
};

const PRODUCTS = ["forkop", "prokop", "podkop", "tachyon"];

// Пакеты, которые относятся к продукту. Нужны для прозрачного списка
// «что установлено» и для удаления только выбранных пакетов.
const PRODUCT_PACKAGES = {
	forkop: [ "forkop", "luci-app-forkop", "luci-i18n-forkop-ru", "sing-box-forkop" ],
	prokop: [ "prokop", "luci-app-prokop", "luci-i18n-prokop-ru" ],
	podkop: [ "podkop", "luci-app-podkop" ],
	tachyon: [ "tachyon", "luci-app-tachyon", "luci-i18n-tachyon-ru", "tachyon-core" ]
};

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

function package_installed(product) {
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
	if (!apk.ok)
		return false;
	// apk info -e <virtual> печатает имя пакета-провайдера. Tachyon
	// объявляет виртуальные forkop/luci-app-forkop, поэтому проверяем
	// именно точное имя, иначе получаем ложный конфликт продуктов.
	for (let line in split(apk.stdout, "\n")) {
		if (trim(line) == product)
			return true;
	}
	return false;
}

function product_installed(product) {
	// У Podkop конфиг создаётся установщиком до готовности пакета; одного
	// /etc/config/podkop недостаточно, иначе неполная установка считается рабочей.
	// Конфиг без бинарника/службы/пакета — это остаток после смены продукта
	// (Tachyon сохраняет конфиги Podkop/Forkop для миграции), а не продукт.
	if (util.file_exists(product_binary(product)) || util.file_exists("/etc/init.d/" + product))
		return true;

	// Бинарник и конфиг могут отсутствовать при частично снятом пакете.
	// Список пакетов — последняя проверка, чтобы не устанавливать второй продукт.
	return package_installed(product);
}

function detect_product() {
	let found = [];
	for (let product in PRODUCTS) {
		if (product_installed(product))
			push(found, product);
	}
	if (length(found) > 1)
		return "conflict";
	return length(found) == 1 ? found[0] : "unknown";
}

function product_version(product) {
	if (product != "forkop" && product != "prokop" && product != "podkop" && product != "tachyon")
		return "";
	let result = run.run_product(product, ["show_version"], 15);
	if (!result.ok)
		return "";
	return run.first_line(result.stdout);
}

let products_cache = { at: -1000, value: [] };

function installed_packages() {
	let installed = {};
	let list = run.run([ "opkg", "list-installed" ], 20);
	if (list.ok) {
		for (let line in split(list.stdout, "\n")) {
			let name = split(trim(line), " ")[0];
			if (name != "")
				installed[name] = true;
		}
		return installed;
	}
	for (let product in PRODUCTS) {
		for (let pkg in PRODUCT_PACKAGES[product]) {
			let apk = run.run([ "apk", "info", "-e", pkg ], 10);
			if (!apk.ok)
				continue;
			for (let line in split(apk.stdout, "\n")) {
				if (trim(line) == pkg)
					installed[pkg] = true;
			}
		}
	}
	return installed;
}

// Список установленных продуктов с версиями и пакетами. Кэш на минуту:
// probe вызывается часто, а opkg/apk list — не бесплатный.
function installed_products(force) {
	let now = util.now_epoch();
	if (!force && now - products_cache.at < 60)
		return products_cache.value;
	let installed = installed_packages();
	let out = [];
	for (let product in PRODUCTS) {
		if (!product_installed(product))
			continue;
		let packages = [];
		for (let pkg in PRODUCT_PACKAGES[product]) {
			if (installed[pkg] === true)
				push(packages, pkg);
		}
		push(out, {
			product: product,
			version: product_version(product),
			packages: packages
		});
	}
	products_cache = { at: now, value: out };
	return out;
}

function package_product(name) {
	for (let product in PRODUCT_PACKAGES) {
		for (let pkg in PRODUCT_PACKAGES[product]) {
			if (pkg == name)
				return product;
		}
	}
	return "";
}

function sing_box_info(product) {
	let version = "";
	let variant = "";

	if (product == "forkop" || product == "prokop" || product == "podkop" || product == "tachyon") {
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
	if (product == "podkop" && variant == "")
		variant = "podkop";
	if (variant == "" && index(version, "extended") >= 0)
		variant = index(version, "compressed") >= 0 ? "extended_compressed" : "extended";

	return { version: version, variant: variant };
}

function manifest_version(product) {
	if (product != "forkop" && product != "prokop" && product != "tachyon")
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

function podkop_ui_state() {
	let status = null;
	let sb = null;
	let status_res = run.run_product("podkop", ["get_status"], 20);
	if (status_res.ok)
		status = util.json_parse(status_res.stdout);
	let sb_res = run.run_product("podkop", ["get_sing_box_status"], 20);
	if (sb_res.ok)
		sb = util.json_parse(sb_res.stdout);

	let enabled = type(status) == "object" && int(status.enabled) == 1;
	let running = type(sb) == "object" && int(sb.running) == 1;
	let dns_configured = type(sb) == "object" && int(sb.dns_configured) == 1;
	return {
		service: {
			podkop: {
				running: running,
				enabled: enabled,
				dns_configured: dns_configured
			},
			sing_box: {
				running: running,
				enabled: type(sb) == "object" && int(sb.enabled) == 1,
				dns_configured: dns_configured
			}
		},
		capabilities: {}
	};
}

function get_ui_state(product) {
	if (product == "podkop")
		return podkop_ui_state();
	if (product != "forkop" && product != "prokop" && product != "tachyon")
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

	let own = (product == "forkop" || product == "prokop" || product == "podkop" || product == "tachyon") && type(service[product]) == "object"
		? service[product] : {};
	let sing_box = type(service.sing_box) == "object" ? service.sing_box : {};
	let present = length(keys(service)) > 0;

	let product_running = util.is_true(own.running);
	let product_enabled = util.is_true(own.enabled);
	let sing_box_running = util.is_true(sing_box.running);
	let sing_box_enabled = util.is_true(sing_box.enabled);
	let dns_configured = util.is_true(own.dns_configured);
	// Prokop/Forkop/Podkop сами запускают sing-box и штатно отключают его
	// standalone автозапуск. Для них выключенный /etc/rc.d/S99sing-box — норма,
	// если продукт включён и запущен.
	let sing_box_managed = (product == "forkop" || product == "prokop" || product == "podkop" || product == "tachyon") &&
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
	let writable = platform == "ok" && (product == "forkop" || product == "prokop" || product == "tachyon");
	return {
		product: product,
		readonly: !writable,
		write_reason: writable ? null : (platform == "conflict" ? "product_conflict"
			: platform == "unsupported" ? "unsupported_platform"
			: product == "podkop" ? "podkop_readonly" : "product_unknown"),
		snapshots: product == "prokop" ? "native" : ((product == "forkop" || product == "tachyon") ? "local" : "none"),
		sing_box: product == "forkop" || product == "prokop" || product == "podkop" || product == "tachyon",
		proxy_health: true,
		diagnostics: true,
		service_actions: ["restart", "start", "stop", "enable", "disable"],
		uci_allowlist: product == "forkop" || product == "prokop" || product == "tachyon"
	};
}

return {
	SUPPORTED_ARCH, PRODUCTS,
	release_info, openwrt_version, arch, target, model,
	supported_arch, supported_openwrt,
	product_config, product_binary, detect_product, product_version,
	PRODUCT_PACKAGES, installed_products, package_product,
	sing_box_info, manifest_version, platform_state, get_ui_state,
	ui_state_values, capability_view
};
