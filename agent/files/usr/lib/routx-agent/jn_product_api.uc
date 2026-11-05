// RoutX: доступ к Clash API разных поколений Forkop/Prokop/Podkop.
// У Forkop 2.x CLI стал транспортом REST: `forkop clash_api METHOD PATH [BODY]`.
// В Forkop 1.x и Prokop/Podkop остались команды get_proxies/get_proxy_latency.
const run = require("jn_run");
const util = require("jn_util");
const platform = require("jn_platform");

const DEFAULT_TARGET = "https://www.gstatic.com/generate_204";

let forkop_v2 = null;

function is_forkop_v2(product) {
	if (product != "forkop")
		return false;
	if (forkop_v2 == null) {
		let version = platform.product_version("forkop");
		let m = match(version, /^v?([0-9]+)/);
		forkop_v2 = m != null && int(m[1]) >= 2;
	}
	return forkop_v2;
}

function as_string(value) {
	return util.as_string(value);
}

function error_text(result) {
	return run.error_text(result);
}

function legacy(product, args, timeout) {
	let res = run.run_product(product, args, timeout);
	if (!res.ok)
		return { ok: false, error: error_text(res) };
	let value = util.json_parse(res.stdout);
	if (type(value) != "object")
		return { ok: false, error: "invalid_json" };
	return { ok: true, value: value };
}

function encode(value) {
	let text = as_string(value);
	let out = "";
	for (let i = 0; i < length(text); i++) {
		let code = ord(substr(text, i, 1));
		if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
			code == 45 || code == 46 || code == 95 || code == 126)
			out += substr(text, i, 1);
		else if (code <= 255)
			out += sprintf("%%%02X", code);
		else if (code <= 2047)
			out += sprintf("%%%02X%%%02X", 192 + (code >> 6), 128 + (code & 63));
		else if (code <= 65535)
			out += sprintf("%%%02X%%%02X%%%02X", 224 + (code >> 12), 128 + ((code >> 6) & 63), 128 + (code & 63));
		else
			out += sprintf("%%%02X%%%02X%%%02X%%%02X", 240 + (code >> 18), 128 + ((code >> 12) & 63),
				128 + ((code >> 6) & 63), 128 + (code & 63));
	}
	return out;
}

function request(product, method, path, body, timeout) {
	let args = [ "clash_api", method, path ];
	if (body != null)
		push(args, body);
	let res = run.run_product(product, args, timeout == null ? 20 : timeout);
	if (!res.ok)
		return { ok: false, error: error_text(res) };
	let wrapper = util.json_parse(res.stdout);
	if (type(wrapper) != "object")
		return { ok: false, error: "invalid_json" };
	let status = int(wrapper.status);
	if (status < 200 || status >= 300)
		return { ok: false, error: "http_" + status, status: status };
	return { ok: true, status: status, body: as_string(wrapper.body) };
}

function json_request(product, method, path, body, timeout) {
	let res = request(product, method, path, body, timeout);
	if (!res.ok)
		return res;
	let value = util.json_parse(res.body);
	if (type(value) != "object")
		return { ok: false, error: "invalid_json" };
	return { ok: true, value: value };
}

function get_proxies(product, timeout) {
	if (is_forkop_v2(product)) {
		let res = json_request(product, "GET", "/proxies", null, timeout);
		if (res.ok && type(res.value.proxies) != "object")
			return { ok: false, error: "invalid_json" };
		return res;
	}
	return legacy(product, [ "clash_api", "get_proxies" ], timeout);
}

function latency_argv(product, tag, timeout_ms, target) {
	let timeout = as_string(timeout_ms == null ? "5000" : timeout_ms);
	let url = target == null || target == "" ? DEFAULT_TARGET : as_string(target);
	if (is_forkop_v2(product)) {
		return [
			"/usr/bin/forkop", "clash_api", "GET",
			"/proxies/" + encode(tag) + "/delay?url=" + encode(url) + "&timeout=" + encode(timeout)
		];
	}
	let args = [ "/usr/bin/" + product, "clash_api", "get_proxy_latency", tag, timeout ];
	if (target != null && target != "")
		push(args, as_string(target));
	return args;
}

function proxy_latency(product, tag, timeout_ms, target) {
	let timeout = as_string(timeout_ms == null ? "5000" : timeout_ms);
	let url = target == null || target == "" ? DEFAULT_TARGET : as_string(target);
	if (is_forkop_v2(product)) {
		return json_request(product, "GET",
			"/proxies/" + encode(tag) + "/delay?url=" + encode(url) + "&timeout=" + encode(timeout),
			null, 30);
	}
	let args = [ "clash_api", "get_proxy_latency", tag, timeout ];
	if (target != null && target != "")
		push(args, as_string(target));
	return legacy(product, args, 20);
}

function group_latency(product, group, timeout_ms) {
	let timeout = as_string(timeout_ms == null ? "5000" : timeout_ms);
	if (is_forkop_v2(product)) {
		return json_request(product, "GET",
			"/group/" + encode(group) + "/delay?url=" + encode(DEFAULT_TARGET) + "&timeout=" + encode(timeout),
			null, 30);
	}
	return legacy(product, [ "clash_api", "get_group_latency", group, timeout ], 30);
}

function set_group_proxy(product, group, tag) {
	if (is_forkop_v2(product)) {
		let body = sprintf("%J", { name: as_string(tag) });
		let res = request(product, "PUT", "/proxies/" + encode(group), body, 30);
		return res.ok ? { ok: true } : res;
	}
	let res = legacy(product, [ "clash_api", "set_group_proxy", group, tag ], 30);
	if (!res.ok)
		return res;
	if (res.value.success !== true)
		return { ok: false, error: as_string(res.value.message) || "select_failed" };
	return { ok: true };
}

function proxy_exit_ip(product, tag, timeout_ms) {
	if (!is_forkop_v2(product))
		return { ok: false, error: "unsupported" };
	let timeout = as_string(timeout_ms == null ? "5000" : timeout_ms);
	let res = json_request(product, "GET",
		"/proxies/" + encode(tag) + "/exit?timeout=" + encode(timeout), null, 30);
	if (!res.ok)
		return res;
	let ipv4 = type(res.value.ipv4) == "object" ? as_string(res.value.ipv4.address) : "";
	let ipv6 = type(res.value.ipv6) == "object" ? as_string(res.value.ipv6.address) : "";
	return { ok: true, ip: ipv4 != "" ? ipv4 : ipv6 };
}

return {
	DEFAULT_TARGET, is_forkop_v2, encode,
	get_proxies, latency_argv, proxy_latency, group_latency, set_group_proxy, proxy_exit_ip
};
