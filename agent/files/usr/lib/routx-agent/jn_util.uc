// RoutX: общие примитивы (строки, JSON, хэши, файлы, время).
// Модуль не обращается к сети и не меняет конфигурацию продукта.

const fs = require("fs");
const digest = require("digest");

const RUN_DIR = "/var/run/routx-agent";
const STATE_DIR = "/etc/routx-agent";
const SNAPSHOT_DIR = STATE_DIR + "/snapshots";

function as_string(value) {
	if (value == null)
		return "";
	return "" + value;
}

// Экранирование для /bin/sh -c: fs.popen() в OpenWrt 24.10 принимает только
// строку, поэтому argv собирается вручную из одинарных кавычек.
function shell_quote(value) {
	return "'" + replace(as_string(value), /'/g, "'\\''") + "'";
}

function as_int(value, fallback) {
	let n = int(value);
	if (n == null || n != n)
		return fallback == null ? 0 : fallback;
	return n;
}

function is_true(value) {
	if (value === true)
		return true;
	if (value === false || value == null)
		return false;
	let s = lc(as_string(value));
	return s == "1" || s == "true" || s == "yes" || s == "on";
}

function trim_lines(value) {
	let lines = [];
	for (let line in split(as_string(value), "\n"))
		push(lines, rtrim(line));
	return join("\n", lines);
}

function byte_len(value) {
	return length(as_string(value));
}

function truncate_text(value, max_bytes, suffix) {
	let text = as_string(value);
	if (length(text) <= max_bytes)
		return text;
	return substr(text, 0, max_bytes) + (suffix == null ? "\n... (truncated)" : suffix);
}

function read_file(path, fallback) {
	let data = fs.readfile(path);
	return data == null ? (fallback == null ? "" : fallback) : as_string(data);
}

function file_exists(path) {
	return fs.stat(path) != null;
}

function file_size(path) {
	let st = fs.stat(path);
	return st == null ? null : int(st.size);
}

function file_sha256(path) {
	let data = fs.readfile(path);
	if (data == null)
		return null;
	return digest.sha256(as_string(data));
}

function last_index(haystack, needle) {
	return rindex(as_string(haystack), as_string(needle));
}

function dirname(path) {
	let value = as_string(path);
	let idx = rindex(value, "/");
	if (idx <= 0)
		return "/";
	return substr(value, 0, idx);
}

function mkdir_p(path, mode) {
	let value = as_string(path);
	if (value == "" || value == "/")
		return true;
	let st = fs.stat(value);
	if (st != null)
		return st.type == "directory";
	let parent = dirname(value);
	if (parent != value && parent != "")
		mkdir_p(parent, mode);
	fs.mkdir(value);
	fs.chmod(value, mode == null ? 0755 : mode);
	st = fs.stat(value);
	return st != null && st.type == "directory";
}

function random_hex(nbytes) {
	let count = nbytes == null ? 16 : nbytes;
	let handle = fs.open("/dev/urandom", "r");
	if (handle == null) {
		// Крайний случай: /dev/urandom недоступен. Это значение используется
		// только для nonce и имён временных файлов, не для токенов.
		let raw = "";
		let seed = clock();
		for (let i = 0; i < count; i++)
			raw = raw + chr((seed[0] + seed[1] + i * 131) % 256);
		return hexenc(raw);
	}
	let raw = handle.read(count);
	handle.close();
	if (raw == null)
		return "";
	return hexenc(raw);
}

function write_atomic(path, content, mode) {
	let value = as_string(path);
	let tmp = value + ".tmp." + random_hex(6);
	if (fs.writefile(tmp, as_string(content)) == null)
		return false;
	fs.chmod(tmp, mode == null ? 0600 : mode);
	if (fs.rename(tmp, value) == null) {
		fs.unlink(tmp);
		return false;
	}
	return true;
}

function now_epoch() {
	return int(clock()[0]);
}

function iso8601(epoch) {
	let t = gmtime(int(epoch));
	return sprintf("%04d-%02d-%02dT%02d:%02d:%02dZ",
		t.year, t.mon, t.mday, t.hour, t.min, t.sec);
}

function iso_now() {
	return iso8601(now_epoch());
}

// Обратное преобразование ISO 8601 (UTC) в epoch. Нужно только для
// компенсации расхождения часов по полю server_time.
function epoch_from_iso(value) {
	let m = match(as_string(value), /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})/);
	if (m == null)
		return null;
	let y = int(m[1]), mo = int(m[2]), d = int(m[3]);
	let h = int(m[4]), mi = int(m[5]), se = int(m[6]);
	y = y - (mo <= 2 ? 1 : 0);
	let era = int((y >= 0 ? y : y - 399) / 400);
	let yoe = y - era * 400;
	let doy = int((153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5) + d - 1;
	let doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy;
	let days = era * 146097 + doe - 719468;
	return days * 86400 + h * 3600 + mi * 60 + se;
}

// Полностью повторяет canonicalJson() сервера: ключи объектов сортируются,
// порядок массивов сохраняется, компактный JSON. Строки сериализуются через
// встроенный %J, чтобы экранирование совпадало с JSON.
function canonical_json(value) {
	let kind = type(value);
	if (kind == "array") {
		let parts = [];
		for (let item in value)
			push(parts, canonical_json(item));
		return "[" + join(",", parts) + "]";
	}
	if (kind == "object") {
		let names = keys(value);
		sort(names);
		let parts = [];
		for (let name in names) {
			let item = value[name];
			if (item == null)
				continue;
			push(parts, sprintf("%J", name) + ":" + canonical_json(item));
		}
		return "{" + join(",", parts) + "}";
	}
	return sprintf("%J", value);
}

function sha256_hex(value) {
	return digest.sha256(as_string(value));
}

function hmac_sha256_hex(key, message) {
	let secret = as_string(key);
	if (length(secret) > 64)
		secret = hexdec(digest.sha256(secret));
	while (length(secret) < 64)
		secret = secret + chr(0);
	let ipad = "";
	let opad = "";
	for (let i = 0; i < 64; i++) {
		let byte = ord(secret, i);
		ipad = ipad + chr(byte ^ 0x36);
		opad = opad + chr(byte ^ 0x5c);
	}
	return digest.sha256(opad + hexdec(digest.sha256(ipad + as_string(message))));
}

function json_parse(value) {
	try {
		let parsed = json(as_string(value));
		return parsed;
	}
	catch (e) {
		return null;
	}
}

function json_string(value) {
	return sprintf("%J", value);
}

function mask_secrets(value) {
	let text = as_string(value);
	text = replace(text, /(vless|vmess|trojan|ss|ssr|hysteria2?|tuic):\/\/[^ \t\r\n"'<>]+/gi, "***");
	text = replace(text, /[a-f0-9]{32,}/gi, "***");
	text = replace(text, /(password|passwd|secret|token|api[_-]?key)[ \t]*[=:][ \t]*("[^"]*"|[^ \t,;]+)/gi, "***=***");
	return text;
}

function dedupe(values) {
	let seen = {};
	let out = [];
	for (let item in values) {
		let key = as_string(item);
		if (key == "" || seen[key])
			continue;
		seen[key] = true;
		push(out, item);
	}
	return out;
}

function selected_keys(object) {
	let names = [];
	for (let name in object)
		if (substr(name, 0, 1) != ".")
			push(names, name);
	sort(names);
	return names;
}

return {
	RUN_DIR, STATE_DIR, SNAPSHOT_DIR,
	as_string, as_int, is_true, trim_lines, byte_len, truncate_text, shell_quote,
	read_file, file_exists, file_size, file_sha256,
	last_index, dirname, mkdir_p, random_hex, write_atomic,
	now_epoch, iso8601, iso_now, epoch_from_iso,
	canonical_json, sha256_hex, hmac_sha256_hex, json_parse, json_string,
	mask_secrets, dedupe, selected_keys
};
