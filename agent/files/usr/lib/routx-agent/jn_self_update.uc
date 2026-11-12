// RoutX: self-update агента по команде панели.
//
// Пакет скачивается и проверяется по SHA-256, затем установка запускается
// отдельным detached-процессом: opkg/apk останавливает текущий агент, поэтому
// устанавливать пакет внутри самого обрабатываемого процесса нельзя.

const fs = require("fs");
const util = require("jn_util");
const run = require("jn_run");

const UPDATE_DIR = "/tmp/routx-agent-update";
const MAX_PACKAGE_BYTES = "20971520";

function fail(error, message) {
	return { ok: false, error: error, message: message };
}

function cleanup() {
	run.run([ "rm", "-rf", UPDATE_DIR ], 5);
}

function package_kind() {
	if (util.file_exists("/usr/bin/apk") || util.file_exists("/sbin/apk"))
		return "apk";
	return "ipk";
}

function download(url, target, seconds) {
	let result = run.run([
		"curl", "-q", "-fsSL", "--max-time", "" + seconds,
		"--max-filesize", MAX_PACKAGE_BYTES, "-o", target, url
	], seconds + 10);
	if (!result.ok)
		return result.timed_out ? "timeout" : run.error_text(result);
	return "";
}

function checksum(path) {
	let result = run.run([ "sha256sum", path ], 15);
	if (!result.ok)
		return "";
	let parts = split(trim(util.as_string(result.stdout)), " ");
	return length(parts) > 0 ? lc(parts[0]) : "";
}

function expected_checksum(text, kind) {
	let wanted = "routx-agent." + kind;
	for (let line in split(util.as_string(text), "\n")) {
		let parts = split(trim(line), " ");
		if (length(parts) >= 2 && parts[length(parts) - 1] == wanted)
			return lc(parts[0]);
	}
	return "";
}

function update_script(kind, version) {
	return join("\n", [
		"#!/bin/sh",
		"sleep 2",
		"rc=1",
		"# Новому агенту нужны модули ucode, которых может не быть на старых",
		"# установках: ставим их до замены пакета.",
		"if [ -x /usr/bin/apk ] || [ -x /sbin/apk ]; then",
		"  APK=$(command -v apk)",
		"  \"$APK\" update >/dev/null 2>&1",
		"  \"$APK\" add ucode-mod-digest ucode-mod-fs ucode-mod-uci >/dev/null 2>&1",
		"else",
		"  opkg update >/dev/null 2>&1",
		"  opkg install ucode-mod-digest ucode-mod-fs ucode-mod-uci >/dev/null 2>&1",
		"fi",
		"if [ -x /usr/bin/apk ] || [ -x /sbin/apk ]; then",
		"  APK=$(command -v apk)",
		"  \"$APK\" add --allow-untrusted " + util.shell_quote(UPDATE_DIR + "/package." + kind),
		"  rc=$?",
		"  if [ \"$rc\" != \"0\" ]; then",
		"    \"$APK\" add --allow-untrusted --force-overwrite " + util.shell_quote(UPDATE_DIR + "/package." + kind),
		"    rc=$?",
		"  fi",
		"else",
		"  opkg install --force-reinstall --force-depends " + util.shell_quote(UPDATE_DIR + "/package." + kind),
		"  rc=$?",
		"fi",
		"if [ \"$rc\" = \"0\" ]; then",
		"  /etc/init.d/routx-agent enable 2>/dev/null",
		"fi",
		"# prerm останавливает старый агент до установки. Перезапускаем его",
		"# даже при ошибке opkg, иначе роутер останется без связи с панелью.",
		"/etc/init.d/routx-agent restart 2>/dev/null",
		"echo \"$(date) rc=$rc kind=" + kind + " version=" + version + "\" >> /var/log/routx-agent-update.log",
		"rm -rf " + util.shell_quote(UPDATE_DIR),
		"",
	]);
}

function handle(product, args) {
	let base = trim(util.as_string(args.base_url));
	if (match(base, /^https?:\/\/[^ \t\r\n]+$/) == null)
		return fail("invalid_base_url", "Некорректный адрес панели");
	base = replace(base, /\/+$/, "");

	let kind = package_kind();
	if (kind != "ipk" && kind != "apk")
		return fail("unsupported_package_manager", "Не найден opkg или apk");
	let version = trim(util.as_string(args.version));

	cleanup();
	util.mkdir_p(UPDATE_DIR, 0700);

	let sum_file = UPDATE_DIR + "/routx-agent.sha256";
	let error = download(base + "/agent/routx-agent.sha256", sum_file, 30);
	if (error != "") {
		cleanup();
		return fail("checksum_download_failed", error);
	}

	let expected = expected_checksum(util.read_file(sum_file, ""), kind);
	if (expected == "") {
		cleanup();
		return fail("checksum_missing", "В файле SHA-256 нет пакета " + kind);
	}

	let package_file = UPDATE_DIR + "/package." + kind;
	error = download(base + "/agent/routx-agent." + kind, package_file, 120);
	if (error != "") {
		cleanup();
		return fail("package_download_failed", error);
	}

	let actual = checksum(package_file);
	if (actual == "" || actual != expected) {
		cleanup();
		return fail("checksum_mismatch", "SHA-256 скачанного пакета не совпал");
	}

	let script = UPDATE_DIR + "/update.sh";
	let fh = fs.open(script, "w", 0700);
	if (fh == null) {
		cleanup();
		return fail("script_failed", "Не удалось создать скрипт обновления");
	}
	fh.write(update_script(kind, version));
	fh.close();
	fs.chmod(script, 0700);

	// Ответ должен уйти до остановки агента. Установка идёт отдельным процессом.
	system("(sh " + util.shell_quote(script) + ") >/dev/null 2>&1 &");

	return {
		ok: true,
		scheduled: true,
		kind: kind,
		version: version,
		sha256: expected
	};
}

return { handle };
