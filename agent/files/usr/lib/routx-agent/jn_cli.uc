// RoutX: CLI
const config = require("jn_config");
const platform = require("jn_platform");
const client = require("jn_client");
const daemon = require("jn_daemon");
const util = require("jn_util");

function usage() {
	print("RoutX agent\n\n");
	print("Usage: routx-agent <command>\n\n");
	print("Commands:\n");
	print("  status      Show agent status\n");
	print("  bind        Bind using bind_token\n");
	print("  probe       Send probe\n");
	print("  rotate      Rotate the agent secret\n");
	print("  mobile-qr   Print a one-time mobile login QR (JSON)\n");
	print("  mobile-devices  List authorized phones (JSON)\n");
	print("  mobile-revoke <id>  Revoke an authorized phone\n");
	print("  run         Run daemon in foreground\n");
	print("  version     Show version\n");
}

function cmd_status() {
	let cfg = config.load();
	let prod = platform.detect_product();
	printf("enabled: %s\n", cfg.enabled ? "yes" : "no");
	printf("bound: %s\n", cfg.bound ? "yes" : "no");
	printf("server: %s\n", cfg.server);
	printf("router_id: %s\n", cfg.router_id);
	printf("product: %s\n", prod);
	printf("arch: %s\n", platform.arch());
	printf("openwrt: %s\n", platform.openwrt_version());
	let sb = platform.sing_box_info(prod);
	printf("sing-box: %s (%s)\n", sb.version == "" ? "unknown" : sb.version, sb.variant);
	return 0;
}

function cmd_bind() {
	let prod = platform.detect_product();
	if (prod == "conflict") { warn("product_conflict\n"); return 1; }
	if (prod == "unknown") { warn("product_unknown\n"); return 1; }
	let res = client.bind(prod);
	if (!res.ok) { warn(res.error + "\n"); return 1; }
	print("Привязка успешна, router_id=" + res.router_id + "\n");
	return 0;
}

function cmd_probe() {
	let prod = platform.detect_product();
	let res = client.probe(prod);
	if (!res.ok) { warn(res.error + "\n"); return 1; }
	print("probe ok\n");
	return 0;
}

function cmd_rotate() {
	let res = client.rotate();
	if (!res.ok) { warn(res.error + "\n"); return 1; }
	print("Секрет агента обновлён\n");
	return 0;
}

// Печатает JSON для LuCI: ссылку, QR (data URL) и срок действия.
// Секретов в выводе нет: токен одноразовый и живёт 5 минут.
function cmd_mobile_qr() {
	let res = client.mobile_link();
	if (!res.ok) {
		warn(res.error + "\n");
		print(util.json_string({ ok: false, error: res.error }) + "\n");
		return 1;
	}
	print(util.json_string({
		ok: true,
		url: res.url,
		qr: res.qr,
		expires_at: res.expires_at,
		ttl_seconds: res.ttl_seconds,
		https: res.https
	}) + "\n");
	return 0;
}

function cmd_mobile_devices() {
	let res = client.mobile_devices();
	if (!res.ok) {
		warn(res.error + "\n");
		print(util.json_string({ ok: false, error: res.error }) + "\n");
		return 1;
	}
	print(util.json_string({ ok: true, items: res.items }) + "\n");
	return 0;
}

function cmd_mobile_revoke(id) {
	if (id == null || id == "") {
		warn("укажите идентификатор устройства\n");
		return 1;
	}
	if (!match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)) {
		warn("некорректный идентификатор устройства\n");
		return 1;
	}
	let res = client.mobile_revoke(id);
	if (!res.ok) {
		warn(res.error + "\n");
		print(util.json_string({ ok: false, error: res.error }) + "\n");
		return 1;
	}
	print(util.json_string({ ok: true }) + "\n");
	return 0;
}

function main() {
	let cmd = ARGV[0] || "status";
	if (cmd == "status") return cmd_status();
	if (cmd == "bind") return cmd_bind();
	if (cmd == "probe") return cmd_probe();
	if (cmd == "rotate") return cmd_rotate();
	if (cmd == "mobile-qr") return cmd_mobile_qr();
	if (cmd == "mobile-devices") return cmd_mobile_devices();
	if (cmd == "mobile-revoke") return cmd_mobile_revoke(ARGV[1]);
	if (cmd == "run") return daemon.run();
	if (cmd == "start") { system("/etc/init.d/routx-agent start"); return 0; }
	if (cmd == "stop") { system("/etc/init.d/routx-agent stop"); return 0; }
	if (cmd == "version") { print(client.VERSION + "\n"); return 0; }
	usage();
	return 1;
}

exit(main());
