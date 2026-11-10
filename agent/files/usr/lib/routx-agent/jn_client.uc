// RoutX: клиент протокола RoutX
const util = require("jn_util");
const http = require("jn_http");
const config = require("jn_config");
const store = require("jn_store");
const platform = require("jn_platform");
const uci_state = require("jn_uci_state");

const VERSION = "1.5.45";

function build_probe(product) {
	let pver = platform.product_version(product);
	let sb = platform.sing_box_info(product);
	let ui = platform.get_ui_state(product);
	let ui_vals = platform.ui_state_values(product, ui);
	let rs = uci_state.read_state(product);
	return {
		agent_version: VERSION,
		product: product,
		product_version: pver == "" ? null : pver,
		manifest_version: platform.manifest_version(product),
		openwrt: platform.openwrt_version(),
		arch: platform.arch(),
		model: platform.model(),
		sing_box_version: sb.version == "" ? null : sb.version,
		sing_box_variant: sb.variant == "" ? null : sb.variant,
		platform_state: platform.platform_state(product),
		installed_products: platform.installed_products(),
		health: ui_vals.health,
		service: ui_vals.service,
		capabilities: platform.capability_view(product),
		managed: rs.managed
	};
}

function set_server_time(st, server_time) {
	let ep = util.epoch_from_iso(server_time);
	if (ep != null) {
		let diff = ep - util.now_epoch();
		if (diff > -600 && diff < 600)
			st.time_offset = diff;
	}
	return st;
}

function bind(product) {
	let cfg = config.load();
	if (cfg.bind_token == "")
		return { ok: false, error: "bind_token не задан" };
	let body = {
		token: cfg.bind_token,
		product: product,
		agent_version: VERSION
	};
	let res = http.request(cfg, "POST", "/agent/v1/bind", body, { unauthenticated: true, timeout: 30 });
	if (!res.ok || type(res.json) != "object")
		return { ok: false, error: res.stderr != "" ? res.stderr : ("HTTP " + res.status) };
	let j = res.json;
	if (j.agent_token == null || j.router_id == null)
		return { ok: false, error: "ответ bind не содержит agent_token/router_id" };
	config.save_bound(j.agent_token, j.router_id, j.server_url || cfg.server, j.poll_hold_seconds);
	return { ok: true, router_id: j.router_id };
}

function probe(product) {
	let cfg = config.load();
	if (!cfg.bound)
		return { ok: false, error: "не привязан" };
	let st = store.load();
	let body = build_probe(product);
	let res = http.request(cfg, "POST", "/agent/v1/probe", body, { timeout: 30, time_offset: st.time_offset });
	if (!res.ok)
		return { ok: false, error: res.stderr != "" ? res.stderr : ("HTTP " + res.status) };
	if (type(res.json) == "object" && res.json.server_time) {
		let st2 = set_server_time(store.load(), res.json.server_time);
		store.save(st2);
	}
	return { ok: true };
}

function poll(product) {
	let cfg = config.load();
	if (!cfg.bound)
		return { ok: false, command: null };
	let st = store.load();
	let res = http.request(cfg, "POST", "/agent/v1/poll", {}, { timeout: cfg.poll_hold_seconds + 10, time_offset: st.time_offset });
	if (res.status == 401)
		return { ok: false, command: null, unauth: true };
	if (!res.ok)
		return { ok: false, command: null };
	if (type(res.json) != "object")
		return { ok: false, command: null };
	if (res.json.server_time) {
		let st2 = set_server_time(store.load(), res.json.server_time);
		store.save(st2);
	}
	let cmd = res.json.command;
	if (type(cmd) == "object" && cmd.id && cmd.op)
		return { ok: true, command: cmd };
	return { ok: true, command: null };
}

function rotate() {
	let cfg = config.load();
	if (!cfg.bound)
		return { ok: false, error: "агент ещё не привязан" };
	let st = store.load();
	let res = http.request(cfg, "POST", "/agent/v1/rotate", {}, { timeout: 30, time_offset: st.time_offset });
	if (!res.ok || type(res.json) != "object")
		return { ok: false, error: res.stderr != "" ? res.stderr : ("HTTP " + res.status) };
	let token = util.as_string(res.json.agent_token);
	if (token == "")
		return { ok: false, error: "сервер не вернул новый секрет" };
	if (!config.save_bound(token, cfg.router_id, cfg.server, cfg.poll_hold_seconds))
		return { ok: false, error: "не удалось сохранить новый секрет" };
	return { ok: true };
}

// Одноразовая ссылка + QR для мобильного входа. Выпускается сервером
// по запросу привязанного агента: QR показывает LuCI на самом роутере.
function mobile_link() {
	let cfg = config.load();
	if (!cfg.bound)
		return { ok: false, error: "агент ещё не привязан" };
	let st = store.load();
	let res = http.request(cfg, "POST", "/agent/v1/mobile-link", {}, { timeout: 15, time_offset: st.time_offset });
	if (!res.ok || type(res.json) != "object")
		return { ok: false, error: res.stderr != "" ? res.stderr : ("HTTP " + res.status) };
	let j = res.json;
	let url = util.as_string(j.url);
	let qr = util.as_string(j.qr_data_url);
	if (url == "" || qr == "")
		return { ok: false, error: "сервер не вернул QR-код" };
	return {
		ok: true,
		url: url,
		qr: qr,
		expires_at: util.as_string(j.expires_at),
		ttl_seconds: util.as_int(j.ttl_seconds, 300),
		https: j.https === true
	};
}

// Авторизованные телефоны роутера. Удаление выполняет только LuCI на самом
// роутере: панель таких маршрутов не имеет.
function mobile_devices() {
	let cfg = config.load();
	if (!cfg.bound)
		return { ok: false, error: "агент ещё не привязан" };
	let st = store.load();
	let res = http.request(cfg, "GET", "/agent/v1/mobile-devices", null, { timeout: 15, time_offset: st.time_offset });
	if (!res.ok || type(res.json) != "object")
		return { ok: false, error: res.stderr != "" ? res.stderr : ("HTTP " + res.status) };
	let items = type(res.json.items) == "array" ? res.json.items : [];
	return { ok: true, items: items };
}

function mobile_revoke(id) {
	let cfg = config.load();
	if (!cfg.bound)
		return { ok: false, error: "агент ещё не привязан" };
	let st = store.load();
	let res = http.request(cfg, "POST", "/agent/v1/mobile-devices/" + id + "/revoke", {}, { timeout: 15, time_offset: st.time_offset });
	if (!res.ok)
		return { ok: false, error: res.stderr != "" ? res.stderr : ("HTTP " + res.status) };
	return { ok: true };
}

function result(command_id, status, res_data, error) {	let cfg = config.load();
	if (!cfg.bound)
		return { ok: false };
	let st = store.load();
	let body = { status: status };
	if (res_data != null)
		body.result = res_data;
	if (error != null)
		body.error = error;
	let res = http.request(cfg, "POST", "/agent/v1/commands/" + command_id + "/result", body, { timeout: 30, time_offset: st.time_offset });
	return { ok: res.ok };
}

function report(kind, product, report_obj, text) {
	let cfg = config.load();
	if (!cfg.bound)
		return { ok: false };
	let payload = text == null ? util.json_string(report_obj) : text;
	let raw = b64enc(util.as_string(payload));
	let sha = util.sha256_hex(util.as_string(payload));
	let body = { kind: kind, product: product, sha256: sha, body: raw };
	let st = store.load();
	let res = http.request(cfg, "POST", "/agent/v1/report", body, { timeout: 60, time_offset: st.time_offset });
	return { ok: res.ok, json: res.json };
}

return { VERSION, build_probe, bind, probe, poll, result, report, rotate, mobile_link, mobile_devices, mobile_revoke, set_server_time };
