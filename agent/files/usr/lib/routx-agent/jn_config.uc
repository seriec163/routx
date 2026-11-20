// RoutX: чтение и запись /etc/config/routx.
// Файл всегда 0600: в нём лежит токен агента.

const fs = require("fs");
const uci = require("uci");
const util = require("jn_util");

const CONFIG = "routx";
const SECTION = "main";
const CONFIG_PATH = "/etc/config/routx";

const DEFAULTS = {
	enabled: "1",
	server: "",
	bind_token: "",
	agent_token: "",
	router_id: "",
	poll_hold_seconds: "25",
	probe_interval: "900",
	verify_tls: "1",
	ca_file: "",
	server_ip: "",
	heavy_probe_every: "10"
};

function ensure_file() {
	if (util.file_exists(CONFIG_PATH))
		return;
	let lines = ["config " + SECTION + " '" + SECTION + "'"];
	for (let key in DEFAULTS)
		push(lines, "\toption " + key + " '" + DEFAULTS[key] + "'");
	util.write_atomic(CONFIG_PATH, join("\n", lines) + "\n", 0600);
}

function raw_section() {
	ensure_file();
	let cursor = uci.cursor();
	let section = cursor.get_all(CONFIG, SECTION);
	return type(section) == "object" ? section : {};
}

function load() {
	let raw = raw_section();
	let cfg = {};
	for (let key in DEFAULTS)
		cfg[key] = raw[key] == null ? DEFAULTS[key] : util.as_string(raw[key]);

	// Совместимость с ранними сборками, где ключ назывался token.
	if (cfg.agent_token == "" && raw.token != null)
		cfg.agent_token = util.as_string(raw.token);

	cfg.server = trim(cfg.server);
	while (length(cfg.server) > 0 && substr(cfg.server, length(cfg.server) - 1) == "/")
		cfg.server = substr(cfg.server, 0, length(cfg.server) - 1);

	cfg.enabled = util.is_true(cfg.enabled);
	cfg.verify_tls = util.is_true(cfg.verify_tls);
	cfg.poll_hold_seconds = util.as_int(cfg.poll_hold_seconds, 25);
	cfg.probe_interval = util.as_int(cfg.probe_interval, 900);
	cfg.heavy_probe_every = util.as_int(cfg.heavy_probe_every, 10);
	if (cfg.poll_hold_seconds < 1 || cfg.poll_hold_seconds > 25)
		cfg.poll_hold_seconds = 25;
	if (cfg.probe_interval < 60)
		cfg.probe_interval = 60;
	if (cfg.heavy_probe_every < 1)
		cfg.heavy_probe_every = 1;
	cfg.bound = cfg.agent_token != "" && cfg.router_id != "";
	cfg.bind_pending = cfg.bind_token != "" && !cfg.bound;
	return cfg;
}

function save(values) {
	ensure_file();
	let cursor = uci.cursor();
	let ok = true;
	for (let key in values) {
		if (cursor.set(CONFIG, SECTION, key, util.as_string(values[key])) == null)
			ok = false;
	}
	if (cursor.commit(CONFIG) == null)
		ok = false;
	fs.chmod(CONFIG_PATH, 0600);
	return ok;
}

function save_bound(token, router_id, server, poll_hold_seconds) {
	let values = {
		agent_token: token,
		router_id: router_id,
		server: server,
		bind_token: ""
	};
	if (poll_hold_seconds != null)
		values.poll_hold_seconds = "" + poll_hold_seconds;
	return save(values);
}

function clear_binding() {
	return save({ bind_token: "", agent_token: "", router_id: "" });
}

function summary() {
	let cfg = load();
	return {
		enabled: cfg.enabled,
		server: cfg.server,
		bound: cfg.bound,
		bind_pending: cfg.bind_pending,
		router_id: cfg.router_id,
		poll_hold_seconds: cfg.poll_hold_seconds,
		probe_interval: cfg.probe_interval,
		verify_tls: cfg.verify_tls,
		token_prefix: cfg.agent_token == "" ? "" : substr(cfg.agent_token, 0, 6),
		token_present: cfg.agent_token != ""
	};
}

return {
	CONFIG, SECTION, CONFIG_PATH, DEFAULTS,
	ensure_file, load, save, save_bound, clear_binding, summary
};
