// RoutX: чтение и редактирование Wi-Fi сетей OpenWrt.
// Панель никогда не получает текущий пароль: отдаём только признак key_set.
// Менять можно SSID, шифрование, пароль, скрытие, отключение и изоляцию.
const fs = require("fs");
const uci = require("uci");
const util = require("jn_util");
const run = require("jn_run");

const CONFIG = "wireless";
const BACKUP_DIR = "/etc/routx-agent/wireless-backups";
const ENCRYPTIONS = [
	"none", "owe", "psk", "psk2", "psk-mixed", "sae", "sae-mixed"
];
const KEY_ENCRYPTIONS = [ "psk", "psk2", "psk-mixed", "sae", "sae-mixed" ];

function needs_key(encryption) {
	return index(KEY_ENCRYPTIONS, encryption) >= 0;
}

function as_string(value) {
	return util.as_string(value);
}

function is_true(value) {
	return value === "1" || value === "true" || value === 1 || value === true;
}

function has_control_chars(value) {
	let text = as_string(value);
	for (let i = 0; i < length(text); i++) {
		let code = ord(substr(text, i, 1));
		if (code < 32 || code == 127)
			return true;
	}
	return false;
}

function iface_from_section(section) {
	let key = as_string(section.key);
	return {
		name: as_string(section[".name"]),
		device: as_string(section.device),
		mode: as_string(section.mode) || "ap",
		network: as_string(section.network),
		ssid: as_string(section.ssid),
		encryption: as_string(section.encryption) || "none",
		key_set: key != "",
		hidden: is_true(section.hidden),
		disabled: is_true(section.disabled),
		isolate: is_true(section.isolate),
		ifname: as_string(section.ifname),
		wds: is_true(section.wds)
	};
}

function hardware_info() {
	let phys = fs.lsdir("/sys/class/ieee80211") || [];
	let interfaces = [];
	let iw_bin = "";
	for (let candidate in [ "/usr/sbin/iw", "/sbin/iw", "/usr/bin/iw" ])
		if (iw_bin == "" && util.file_exists(candidate))
			iw_bin = candidate;
	if (iw_bin != "") {
		let res = run.run([ iw_bin, "dev" ], 10);
		if (res.ok) {
			for (let line in split(util.as_string(res.stdout), "\n")) {
				let text = trim(line);
				if (substr(text, 0, 10) == "Interface ")
					push(interfaces, trim(substr(text, 10)));
			}
		}
	}
	// Некоторые драйверы не создают /sys/class/ieee80211, но у сетевого
	// интерфейса есть ссылка phy80211.
	let net = fs.lsdir("/sys/class/net") || [];
	for (let name in net)
		if (fs.stat("/sys/class/net/" + name + "/phy80211") != null)
			push(interfaces, as_string(name));

	let configured_radios = [];
	let ubus = run.run([ "ubus", "call", "network.wireless", "status" ], 10);
	if (ubus.ok) {
		let data = util.json_parse(ubus.stdout);
		if (type(data) == "object")
			for (let name, value in data)
				push(configured_radios, as_string(name));
	}

	let present = length(phys) > 0 || length(interfaces) > 0;
	return {
		present: present,
		phys: phys,
		interfaces: interfaces,
		configured_radios: configured_radios
	};
}

function read_iface(cursor, name) {
	let all = cursor.get_all(CONFIG);
	let section = all != null ? all[name] : null;
	if (type(section) != "object" || section[".type"] != "wifi-iface")
		return null;
	return iface_from_section(section);
}

function read() {
	let cursor = uci.cursor();
	let all = cursor.get_all(CONFIG);
	if (type(all) != "object")
		all = {};
	let radios = [];
	let interfaces = [];
	for (let name, section in all) {
		if (type(section) != "object")
			continue;
		if (section[".type"] == "wifi-device") {
			push(radios, {
				name: as_string(section[".name"]),
				type: as_string(section.type),
				path: as_string(section.path),
				band: as_string(section.band),
				channel: as_string(section.channel),
				htmode: as_string(section.htmode),
				country: as_string(section.country),
				txpower: as_string(section.txpower),
				disabled: is_true(section.disabled)
			});
		} else if (section[".type"] == "wifi-iface") {
			push(interfaces, iface_from_section(section));
		}
	}
	return { radios: radios, interfaces: interfaces, hardware: hardware_info() };
}

function backup() {
	util.mkdir_p(BACKUP_DIR, 0700);
	let data = fs.readfile("/etc/config/" + CONFIG);
	if (data != null) {
		let name = "wireless-" + util.now_epoch() + ".bak";
		util.write_atomic(BACKUP_DIR + "/" + name, data, 0600);
	}
	// Храним только пять последних копий.
	let files = fs.lsdir(BACKUP_DIR) || [];
	let backups = [];
	for (let name in files)
		if (substr(name, 0, 8) == "wireless" && substr(name, -4) == ".bak")
			push(backups, name);
	backups = sort(backups, function(a, b) { return a > b ? -1 : (a < b ? 1 : 0); });
	for (let i = 5; i < length(backups); i++)
		fs.unlink(BACKUP_DIR + "/" + backups[i]);
}

function uci_bin() {
	return util.file_exists("/sbin/uci") ? "/sbin/uci" : "/usr/bin/uci";
}

function uci_run(args) {
	let bin = uci_bin();
	if (!util.file_exists(bin))
		return { ok: false, error: "Не найден uci" };
	let argv = [ bin ];
	for (let arg in args)
		push(argv, arg);
	return run.run(argv, 20);
}

function uci_revert() {
	uci_run([ "revert", CONFIG ]);
}

function wifi_bin() {
	for (let candidate in [ "/sbin/wifi", "/usr/sbin/wifi", "/usr/bin/wifi" ])
		if (util.file_exists(candidate))
			return candidate;
	return "";
}

function reload_wifi() {
	let bin = wifi_bin();
	if (bin == "")
		return { applied: false, error: "Не найден /sbin/wifi" };
	let res = run.run([ bin, "reload" ], 90);
	return { applied: res.ok, error: res.ok ? "" : run.error_text(res) };
}

function section_slug(value) {
	let text = replace(as_string(value), /[^A-Za-z0-9_]+/g, "_");
	if (length(text) > 24)
		text = substr(text, 0, 24);
	if (text == "")
		text = "wifi";
	return text;
}

function valid_key(value) {
	let key = as_string(value);
	if (length(key) >= 8 && length(key) <= 63)
		return !has_control_chars(key);
	// 64-байтный hexadecimal PSK.
	if (length(key) == 64)
		return match(key, /^[0-9a-fA-F]{64}$/) != null;
	return false;
}

function update(iface, changes) {
	let name = as_string(iface);
	if (name == "")
		return { ok: false, error: "Не указана Wi-Fi сеть" };
	if (type(changes) != "object")
		return { ok: false, error: "Нет изменений" };

	let cursor = uci.cursor();
	let current = read_iface(cursor, name);
	if (current == null)
		return { ok: false, error: "Wi-Fi сеть не найдена" };
	if (!hardware_info().present)
		return { ok: false, error: "На роутере не обнаружен Wi-Fi модуль" };

	let changed = [];
	let encryption = current.encryption;
	if (type(changes.encryption) == "string") {
		encryption = as_string(changes.encryption);
		if (index(ENCRYPTIONS, encryption) < 0)
			return { ok: false, error: "Неподдерживаемый тип шифрования" };
	}

	if (type(changes.ssid) == "string") {
		let ssid = trim(as_string(changes.ssid));
		if (ssid == "" || length(ssid) > 32 || has_control_chars(ssid))
			return { ok: false, error: "SSID должен быть от 1 до 32 символов" };
		changes.ssid = ssid;
	}

	if (type(changes.key) == "string" && as_string(changes.key) != "") {
		if (!needs_key(encryption))
			return { ok: false, error: "Для открытой сети пароль не нужен" };
		if (!valid_key(changes.key))
			return { ok: false, error: "Пароль Wi-Fi должен быть от 8 до 63 символов или 64 hex" };
	}

	let new_key = type(changes.key) == "string" ? as_string(changes.key) : "";
	if (needs_key(encryption) && new_key == "" && !current.key_set)
		return { ok: false, error: "Для защищённой сети нужен пароль" };

	let backup_error = "";
	try {
		backup();
	} catch (e) {
		backup_error = as_string(e);
	}

	if (type(changes.ssid) == "string") {
		cursor.set(CONFIG, name, "ssid", changes.ssid);
		push(changed, "ssid");
	}
	if (type(changes.encryption) == "string") {
		cursor.set(CONFIG, name, "encryption", encryption);
		push(changed, "encryption");
	}
	if (encryption == "none" || encryption == "owe") {
		cursor.delete(CONFIG, name, "key");
		push(changed, "key");
	} else if (type(changes.key) == "string" && as_string(changes.key) != "") {
		cursor.set(CONFIG, name, "key", changes.key);
		push(changed, "key");
	}
	for (let field in [ "hidden", "disabled", "isolate" ]) {
		if (type(changes[field]) == "bool") {
			cursor.set(CONFIG, name, field, changes[field] ? "1" : "0");
			push(changed, field);
		}
	}

	if (length(changed) == 0)
		return { ok: false, error: "Нет изменений" };
	if (cursor.commit(CONFIG) == null)
		return { ok: false, error: "Не удалось сохранить /etc/config/wireless" };

	let reload = reload_wifi();
	let applied = reload.applied;
	let apply_error = reload.error;

	let updated = read_iface(uci.cursor(), name);
	return {
		ok: true,
		iface: updated,
		changed: changed,
		applied: applied,
		error: apply_error,
		backup_error: backup_error
	};
}

function create(options) {
	if (type(options) != "object")
		return { ok: false, error: "Нет данных новой Wi-Fi сети" };
	let ssid = trim(as_string(options.ssid));
	if (ssid == "" || length(ssid) > 32 || has_control_chars(ssid))
		return { ok: false, error: "SSID должен быть от 1 до 32 символов" };
	let encryption = as_string(options.encryption) || "none";
	if (index(ENCRYPTIONS, encryption) < 0)
		return { ok: false, error: "Неподдерживаемый тип шифрования" };
	let key = as_string(options.key);
	if (needs_key(encryption)) {
		if (key == "" || !valid_key(key))
			return { ok: false, error: "Пароль Wi-Fi должен быть от 8 до 63 символов или 64 hex" };
	} else if (key != "") {
		return { ok: false, error: "Для открытой сети пароль не нужен" };
	}
	let hidden = type(options.hidden) == "bool" ? options.hidden : false;
	let disabled = type(options.disabled) == "bool" ? options.disabled : false;
	let isolate = type(options.isolate) == "bool" ? options.isolate : false;

	if (!hardware_info().present)
		return { ok: false, error: "На роутере не обнаружен Wi-Fi модуль" };

	let cursor = uci.cursor();
	let all = cursor.get_all(CONFIG);
	if (type(all) != "object")
		all = {};
	let devices = [];
	for (let name, section in all)
		if (type(section) == "object" && section[".type"] == "wifi-device")
			push(devices, name);
	if (length(devices) == 0) {
		// Модуль есть, но /etc/config/wireless пуст: пробуем сгенерировать
		// радиомодули штатной командой OpenWrt.
		let bin = wifi_bin();
		if (bin != "") {
			try {
				backup();
			} catch (e) {
			}
			run.run([ bin, "config" ], 60);
			cursor = uci.cursor();
			all = cursor.get_all(CONFIG);
			if (type(all) != "object")
				all = {};
			devices = [];
			for (let name, section in all)
				if (type(section) == "object" && section[".type"] == "wifi-device")
					push(devices, name);
		}
	}
	if (length(devices) == 0)
		return { ok: false, error: "Wi-Fi модуль есть, но радиомодули не настроены" };

	let requested = options.radios;
	let selected = [];
	let skipped = [];
	if (type(requested) == "array" && length(requested) > 0) {
		for (let item in requested) {
			let name = as_string(item);
			if (index(devices, name) >= 0)
				push(selected, name);
			else
				push(skipped, name);
		}
	} else {
		for (let device in devices)
			push(selected, device);
	}
	if (length(selected) == 0)
		return { ok: false, error: "Выбранные радиомодули не найдены" };

	// Не создаём второй AP с тем же SSID на том же радио.
	let unique = [];
	for (let device in selected) {
		let duplicate = false;
		for (let name, section in all) {
			if (type(section) == "object" && section[".type"] == "wifi-iface" &&
			    as_string(section.device) == device && as_string(section.ssid) == ssid)
				duplicate = true;
		}
		if (duplicate)
			push(skipped, device);
		else
			push(unique, device);
	}
	if (length(unique) == 0)
		return { ok: false, error: "Сеть с таким SSID уже существует на выбранных радиомодулях" };

	let backup_error = "";
	try {
		backup();
	} catch (e) {
		backup_error = as_string(e);
	}

	let used = {};
	let created_meta = [];
	for (let device in unique) {
		let add = uci_run([ "add", CONFIG, "wifi-iface" ]);
		if (!add.ok) {
			uci_revert();
			return { ok: false, error: run.error_text(add) || "Не удалось создать секцию Wi-Fi" };
		}
		let generated = run.first_line(add.stdout);
		if (generated == "") {
			uci_revert();
			return { ok: false, error: "uci add не вернул имя секции" };
		}
		let base = "routx_" + section_slug(ssid) + "_" + device;
		let name = base;
		let suffix = 2;
		while (all[name] != null || used[name]) {
			name = base + "_" + suffix;
			suffix++;
		}
		used[name] = true;
		let rename = uci_run([ "rename", CONFIG + "." + generated + "=" + name ]);
		if (!rename.ok) {
			uci_revert();
			return { ok: false, error: run.error_text(rename) || "Не удалось переименовать секцию" };
		}
		push(created_meta, { name: name, device: device });
	}

	// Свежий курсор нужен после uci add/rename: старый не знает о новых
	// секциях, и set() в него молча не применяется.
	let writer = uci.cursor();
	for (let entry in created_meta) {
		let name = entry.name;
		writer.set(CONFIG, name, "device", entry.device);
		writer.set(CONFIG, name, "mode", "ap");
		writer.set(CONFIG, name, "network", "lan");
		writer.set(CONFIG, name, "ssid", ssid);
		writer.set(CONFIG, name, "encryption", encryption);
		if (needs_key(encryption))
			writer.set(CONFIG, name, "key", key);
		writer.set(CONFIG, name, "hidden", hidden ? "1" : "0");
		writer.set(CONFIG, name, "disabled", disabled ? "1" : "0");
		writer.set(CONFIG, name, "isolate", isolate ? "1" : "0");
	}
	if (writer.commit(CONFIG) == null) {
		uci_revert();
		return { ok: false, error: "Не удалось сохранить /etc/config/wireless" };
	}

	let reload = reload_wifi();
	let created = [];
	let read_cursor = uci.cursor();
	for (let entry in created_meta) {
		let item = read_iface(read_cursor, entry.name);
		if (item != null)
			push(created, item);
	}

	return {
		ok: true,
		created: created,
		skipped: skipped,
		applied: reload.applied,
		error: reload.error,
		backup_error: backup_error
	};
}

function remove(iface) {
	let name = as_string(iface);
	if (name == "")
		return { ok: false, error: "Не указана Wi-Fi сеть" };
	let cursor = uci.cursor();
	let all = cursor.get_all(CONFIG);
	let section = all != null ? all[name] : null;
	if (type(section) != "object" || section[".type"] != "wifi-iface")
		return { ok: false, error: "Wi-Fi сеть не найдена" };

	let backup_error = "";
	try {
		backup();
	} catch (e) {
		backup_error = as_string(e);
	}

	cursor.delete(CONFIG, name);
	if (cursor.commit(CONFIG) == null)
		return { ok: false, error: "Не удалось сохранить /etc/config/wireless" };
	let reload = reload_wifi();
	return {
		ok: true,
		deleted: name,
		applied: reload.applied,
		error: reload.error,
		backup_error: backup_error
	};
}

return { read, update, create, remove };
