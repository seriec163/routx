// RoutX: запуск внешних команд без shell и без унаследованного окружения.
// Все аргументы передаются массивом в /usr/libexec/routx-agent-exec, который
// вызывает env -i и timeout. Секретов в argv не бывает.

const fs = require("fs");
const util = require("jn_util");

const EXEC = "/usr/libexec/routx-agent-exec";
const EXEC_DIR = util.RUN_DIR + "/exec";

function ensure_dirs() {
	util.mkdir_p(util.RUN_DIR, 0700);
	util.mkdir_p(EXEC_DIR, 0700);
}

function run(argv, timeout_seconds) {
	ensure_dirs();
	let timeout = timeout_seconds == null ? 30 : int(timeout_seconds);
	if (timeout <= 0)
		timeout = 1;
	let id = sprintf("%d-%d-%s", clock()[0], clock()[1], util.random_hex(6));
	let out_path = EXEC_DIR + "/" + id + ".out";
	let err_path = EXEC_DIR + "/" + id + ".err";
	let full = [EXEC, "" + timeout, out_path, err_path, "--"];
	for (let arg in argv)
		push(full, "" + arg);

	let command = "";
	for (let arg in full)
		command = command + (command == "" ? "" : " ") + util.shell_quote(arg);
	let proc = fs.popen(command, "r");
	if (proc == null) {
		fs.unlink(out_path);
		fs.unlink(err_path);
		return {
			ok: false, code: -1, timed_out: false,
			stdout: "", stderr: "не удалось запустить " + argv[0]
		};
	}
	let code = proc.close();
	let stdout = util.read_file(out_path, "");
	let stderr = util.read_file(err_path, "");
	fs.unlink(out_path);
	fs.unlink(err_path);

	// 124 — timeout(1); 137 — SIGKILL от timeout -k.
	let timed_out = code == 124 || code == 137;
	return {
		ok: code == 0,
		code: code,
		timed_out: timed_out,
		stdout: stdout,
		stderr: stderr
	};
}

function run_product(product, args, timeout_seconds) {
	let argv = ["/usr/bin/" + product];
	for (let arg in args)
		push(argv, arg);
	return run(argv, timeout_seconds);
}

function run_init(product, action, timeout_seconds) {
	return run(["/etc/init.d/" + product, action], timeout_seconds);
}

function first_line(value) {
	let text = trim(util.as_string(value));
	let idx = index(text, "\n");
	return idx < 0 ? text : substr(text, 0, idx);
}

function error_text(result) {
	let text = trim(util.as_string(result.stderr));
	if (text == "")
		text = trim(util.as_string(result.stdout));
	if (text == "")
		text = result.timed_out ? "истекло время ожидания" : "код " + result.code;
	return util.truncate_text(util.mask_secrets(text), 800);
}

return {
	EXEC, ensure_dirs, run, run_product, run_init, first_line, error_text
};
