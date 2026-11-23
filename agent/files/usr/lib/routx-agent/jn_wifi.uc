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
	return { radios: radios, interfaces: interfaces };
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

	let applied = false;
	let apply_error = "";
	let wifi_bin = util.file_exists("/sbin/wifi") ? "/sbin/wifi" : "/usr/sbin/wifi";
	if (util.file_exists(wifi_bin)) {
		let res = run.run([ wifi_bin, "reload" ], 90);
		applied = res.ok;
		if (!res.ok)
			apply_error = run.error_text(res);
	} else {
		apply_error = "Не найден /sbin/wifi";
	}

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

return { read, update };
