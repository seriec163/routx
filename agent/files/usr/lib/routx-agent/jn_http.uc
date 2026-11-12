// RoutX: HTTPS-клиент к RoutX.
// Токен и подпись передаются через временный curl-config (0600), а не в argv.
// Тело ответа и HTTP-код пишутся в разные файлы: output в config, write-out в stdout.

const fs = require("fs");
const util = require("jn_util");
const run = require("jn_run");

const HTTP_DIR = util.RUN_DIR + "/http";

// Podkop перехватывает системный DNS и может вернуть FakeIP (198.18.0.0/15)
// для домена панели. Агенту нужен настоящий IP, иначе связь с RoutX зависит
// от VPN. Резолвим напрямую через публичные DNS и передаём curl --resolve.
const DNS_SERVERS = [ "77.88.8.8", "1.1.1.1", "8.8.8.8" ];
const DNS_TTL = 600;
let dns_cache = { host: "", ip: "", at: 0 };

function server_host(value) {
	let text = util.as_string(value);
	let pos = index(text, "://");
	if (pos >= 0)
		text = substr(text, pos + 3);
	let end = length(text);
	for (let ch in [ "/", "?", "#" ]) {
		let p = index(text, ch);
		if (p >= 0 && p < end)
			end = p;
	}
	text = substr(text, 0, end);
	if (substr(text, 0, 1) == "[") {
		let close = index(text, "]");
		return close > 1 ? substr(text, 1, close - 1) : "";
	}
	let colon = rindex(text, ":");
	if (colon >= 0)
		text = substr(text, 0, colon);
	return text;
}

function server_port(value) {
	let text = util.as_string(value);
	if (substr(text, 0, 6) == "https://")
		return "443";
	if (substr(text, 0, 5) == "http://")
		return "80";
	return "443";
}

function is_ip(value) {
	return match(value, /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/) != null ||
		index(value, ":") > 0;
}

function resolve_direct(host) {
	if (host == "" || is_ip(host))
		return "";
	let now = clock()[0];
	if (dns_cache.host == host && now - dns_cache.at < DNS_TTL)
		return dns_cache.ip;
	for (let server in DNS_SERVERS) {
		let res = run.run([ "nslookup", host, server ], 10);
		if (!res.ok)
			continue;
		for (let line in split(res.stdout, "\n")) {
			let m = match(line, /Address:?\s*([0-9]{1,3}(\.[0-9]{1,3}){3})\s*$/);
			if (m == null)
				continue;
			let ip = m[1];
			if (ip == server)
				continue;
			dns_cache = { host: host, ip: ip, at: now };
			return ip;
		}
	}
	return "";
}

function resolve_option(cfg) {
	let host = server_host(cfg.server);
	let ip = util.as_string(cfg.server_ip);
	if (ip == "")
		ip = resolve_direct(host);
	if (ip == "" || host == "")
		return "";
	let port = server_port(cfg.server);
	if (index(ip, ":") > 0)
		ip = "[" + ip + "]";
	return host + ":" + port + ":" + ip;
}

// curl config разбирает строку в кавычках с escape-последовательностями.
function curl_quote(value) {
	let text = util.as_string(value);
	text = replace(text, "\\", "\\\\");
	text = replace(text, "\"", "\\\"");
	text = replace(text, "\r", "\\r");
	text = replace(text, "\n", "\\n");
	return "\"" + text + "\"";
}

function ensure_dir() {
	util.mkdir_p(util.RUN_DIR, 0700);
	util.mkdir_p(HTTP_DIR, 0700);
}

function endpoint(cfg, path) {
	let base = util.as_string(cfg.server);
	return base + path;
}

function cleanup(paths) {
	for (let path in paths) {
		if (path != null && path != "")
			fs.unlink(path);
	}
}

function request(cfg, method, path, body, options) {
	ensure_dir();
	let opts = type(options) == "object" ? options : {};
	let raw_body = body == null ? null : util.canonical_json(body);
	let timeout = util.as_int(opts.timeout, 30);
	if (timeout < 5)
		timeout = 5;

	let base = util.as_string(cfg.server);
	if (base == "")
		return { ok: false, status: 0, body: "", json: null, stderr: "не задан server", code: -1 };
	if (substr(base, 0, 7) != "http://" && substr(base, 0, 8) != "https://")
		return { ok: false, status: 0, body: "", json: null,
			stderr: "server должен начинаться с http:// или https://", code: -1 };

	let id = sprintf("%d-%d-%s", clock()[0], clock()[1], util.random_hex(6));
	let body_path = HTTP_DIR + "/" + id + ".body";
	let resp_path = HTTP_DIR + "/" + id + ".resp";
	let code_path = HTTP_DIR + "/" + id + ".code";
	let cfg_path = HTTP_DIR + "/" + id + ".curl";
	let err_path = HTTP_DIR + "/" + id + ".err";

	if (raw_body != null) {
		if (fs.writefile(body_path, raw_body) == null)
			return { ok: false, status: 0, body: "", json: null,
				stderr: "не удалось записать тело запроса", code: -1 };
		fs.chmod(body_path, 0600);
	}

	let lines = [];
	push(lines, "url = " + curl_quote(endpoint(cfg, path)));
	let resolve = resolve_option(cfg);
	if (resolve != "")
		push(lines, "resolve = " + curl_quote(resolve));
	push(lines, "request = " + curl_quote(method));
	push(lines, "header = " + curl_quote(opts.accept == null ? "Accept: application/json" : opts.accept));
	push(lines, "output = " + curl_quote(resp_path));
	push(lines, "write-out = " + curl_quote("%{http_code}"));
	push(lines, "silent");
	push(lines, "show-error");
	push(lines, "connect-timeout = " + curl_quote("10"));
	push(lines, "max-time = " + curl_quote("" + timeout));

	if (cfg.verify_tls === false)
		push(lines, "insecure");
	else if (util.as_string(cfg.ca_file) != "")
		push(lines, "cacert = " + curl_quote(cfg.ca_file));

	if (raw_body != null) {
		push(lines, "header = " + curl_quote("Content-Type: application/json"));
		push(lines, "data-binary = " + curl_quote("@" + body_path));
	}

	let signed = opts.unauthenticated !== true && util.as_string(cfg.agent_token) != "";
	if (signed) {
		let timestamp = util.now_epoch() + util.as_int(opts.time_offset, 0);
		let nonce = util.random_hex(16);
		let body_hash = util.sha256_hex(raw_body == null ? "" : raw_body);
		let message = method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + body_hash;
		let signature = util.hmac_sha256_hex(cfg.agent_token, message);
		push(lines, "header = " + curl_quote("Authorization: Bearer " + cfg.agent_token));
		push(lines, "header = " + curl_quote("x-rc-timestamp: " + timestamp));
		push(lines, "header = " + curl_quote("x-rc-nonce: " + nonce));
		push(lines, "header = " + curl_quote("x-rc-signature: " + signature));
	}

	if (fs.writefile(cfg_path, join("\n", lines) + "\n") == null) {
		cleanup([body_path]);
		return { ok: false, status: 0, body: "", json: null,
			stderr: "не удалось записать curl-config", code: -1 };
	}
	fs.chmod(cfg_path, 0600);

	// /usr/libexec/routx-agent-exec <timeout> <stdout> <stderr> -- argv...
	// stdout содержит только write-out (HTTP-код), тело ответа curl пишет сам.
	let full = ["/usr/libexec/routx-agent-exec", "" + (timeout + 5), code_path, err_path, "--",
		"curl", "-q", "--config", cfg_path];
	let command = "";
	for (let arg in full)
		command = command + (command == "" ? "" : " ") + util.shell_quote(arg);
	let proc = fs.popen(command, "r");
	let exit_code = -1;
	if (proc != null)
		exit_code = proc.close();

	let status_text = trim(util.read_file(code_path, ""));
	let response = util.read_file(resp_path, "");
	let stderr = trim(util.read_file(err_path, ""));
	cleanup([body_path, resp_path, code_path, cfg_path, err_path]);

	let status = 0;
	let parsed_status = int(status_text);
	if (parsed_status != null && parsed_status > 0 && parsed_status < 1000)
		status = parsed_status;

	if (exit_code != 0 && status == 0 && stderr == "")
		stderr = exit_code == 28 ? "истекло время ожидания" : "curl завершился с кодом " + exit_code;

	return {
		ok: status >= 200 && status < 300,
		status: status,
		body: response,
		json: util.json_parse(response),
		stderr: util.truncate_text(util.mask_secrets(stderr), 500),
		code: exit_code
	};
}

function post(cfg, path, body, options) {
	return request(cfg, "POST", path, body == null ? {} : body, options);
}

function get(cfg, path, options) {
	return request(cfg, "GET", path, null, options);
}

return { HTTP_DIR, curl_quote, request, post, get };
