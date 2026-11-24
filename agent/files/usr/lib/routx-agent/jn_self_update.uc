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
	let pkg = util.shell_quote(UPDATE_DIR + "/package." + kind);
	return join("\n", [
		"#!/bin/sh",
		"sleep 2",
		"LOG=/var/log/routx-agent-update.log",
		"EXPECTED=\"" + version + "\"",
		"KIND=\"" + kind + "\"",
		"PKG=" + pkg,
		"rc=1",
		"verified=\"skipped\"",
		"TO=\"\"",
		"command -v timeout >/dev/null 2>&1 && TO=\"timeout 120\"",
		"log() { echo \"$(date '+%Y-%m-%d %H:%M:%S') $*\" >> \"$LOG\"; }",
		"# Кто держит lock apk (если утилита fuser недоступна).",
		"apk_holders() {",
		"  for p in /proc/[0-9]*; do",
		"    [ -d \"$p/fd\" ] || continue",
		"    ls -l \"$p/fd\" 2>/dev/null | grep -q \"/lib/apk/db/lock\" && echo \"${p#/proc/}:$(cat \"$p/comm\" 2>/dev/null)\"",
		"  done",
		"}",
		"clear_orphan_apk_lock() {",
		"  [ -e /lib/apk/db/lock ] || return 0",
		"  H=$(apk_holders)",
		"  if [ -z \"$H\" ]; then",
		"    log \"apk lock без держателя, удаляем\"",
		"    rm -f /lib/apk/db/lock",
		"  else",
		"    log \"apk lock держит: $H\"",
		"  fi",
		"}",
		"install_apk() {",
		"  n=0",
		"  FLAGS=\"--no-network\"",
		"  while [ \"$n\" -lt 20 ]; do",
		"    n=$((n + 1))",
		"    T=/tmp/routx-apk-attempt.log",
		"    $TO \"$APK\" add $FLAGS --allow-untrusted --force-overwrite \"$PKG\" >\"$T\" 2>&1",
		"    r=$?",
		"    cat \"$T\" >> \"$LOG\"",
		"    [ \"$r\" = \"0\" ] && return 0",
		"    if grep -q \"Unable to lock database\" \"$T\"; then",
		"      clear_orphan_apk_lock",
		"      log \"apk lock занят (попытка $n), ждём 15 с\"",
		"      sleep 15",
		"      continue",
		"    fi",
		"    if [ -n \"$FLAGS\" ]; then",
		"      FLAGS=\"\"",
		"      log \"apk add не удался без сети (rc=$r), повтор с сетью\"",
		"      continue",
		"    fi",
		"    log \"apk add rc=$r (попытка $n), повтор через 10 с\"",
		"    sleep 10",
		"  done",
		"  return 1",
		"}",
		"install_opkg() {",
		"  n=0",
		"  while [ \"$n\" -lt 20 ]; do",
		"    n=$((n + 1))",
		"    T=/tmp/routx-opkg-attempt.log",
		"    $TO opkg install --force-reinstall --force-depends \"$PKG\" >\"$T\" 2>&1",
		"    r=$?",
		"    cat \"$T\" >> \"$LOG\"",
		"    [ \"$r\" = \"0\" ] && return 0",
		"    if grep -qi \"lock\" \"$T\"; then",
		"      if [ -e /var/lock/opkg.lock ] && command -v fuser >/dev/null 2>&1 && [ -z \"$(fuser /var/lock/opkg.lock 2>/dev/null)\" ]; then",
		"        log \"opkg lock без держателя, удаляем\"",
		"        rm -f /var/lock/opkg.lock",
		"      fi",
		"      log \"opkg lock занят (попытка $n), ждём 15 с\"",
		"      sleep 15",
		"      continue",
		"    fi",
		"    log \"opkg rc=$r (попытка $n), повтор через 10 с\"",
		"    sleep 10",
		"  done",
		"  return 1",
		"}",
		"if [ -x /usr/bin/apk ] || [ -x /sbin/apk ]; then",
		"  APK=$(command -v apk)",
		"  # Для локального пакета не нужен apk update: он только трогает lock и сеть.",
		"  for m in ucode-mod-digest ucode-mod-fs ucode-mod-uci; do",
		"    \"$APK\" info -e \"$m\" >/dev/null 2>&1 || $TO \"$APK\" add \"$m\" >>\"$LOG\" 2>&1 || true",
		"  done",
		"  install_apk && rc=0 || rc=1",
		"  if [ \"$rc\" = \"0\" ] && [ -n \"$EXPECTED\" ]; then",
		"    if \"$APK\" info -v routx-agent 2>/dev/null | grep -q \"$EXPECTED\"; then",
		"      verified=\"ok\"",
		"    else",
		"      verified=\"failed\"",
		"    fi",
		"  fi",
		"else",
		"  for m in ucode-mod-digest ucode-mod-fs ucode-mod-uci; do",
		"    opkg list-installed 2>/dev/null | grep -q \"^$m \" || $TO opkg install \"$m\" >>\"$LOG\" 2>&1 || true",
		"  done",
		"  install_opkg && rc=0 || rc=1",
		"  if [ \"$rc\" = \"0\" ] && [ -n \"$EXPECTED\" ]; then",
		"    if opkg status routx-agent 2>/dev/null | grep -q \"Version: $EXPECTED\"; then",
		"      verified=\"ok\"",
		"    else",
		"      verified=\"failed\"",
		"    fi",
		"  fi",
		"fi",
		"if [ \"$rc\" = \"0\" ]; then",
		"  /etc/init.d/routx-agent enable 2>/dev/null",
		"fi",
		"# prerm останавливает старый агент до установки. Перезапускаем его",
		"# даже при ошибке, иначе роутер останется без связи с панелью.",
		"/etc/init.d/routx-agent restart 2>/dev/null",
		"log \"rc=$rc kind=$KIND version=$EXPECTED verified=$verified\"",
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
	// Версия попадает в shell-скрипт и в лог: пропускаем только безопасные символы.
	if (version != "" && match(version, /^[0-9A-Za-z._+-]{1,40}$/) == null)
		return fail("invalid_version", "Некорректная версия агента");

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
