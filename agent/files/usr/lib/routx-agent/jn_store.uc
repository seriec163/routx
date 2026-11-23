// RoutX: небольшое персистентное состояние демона.
// /var/run/routx-agent/state.json, 0600, атомарная замена.

const util = require("jn_util");

const PATH = util.RUN_DIR + "/state.json";

function defaults() {
	return {
		last_command_id: "",
		last_result: null,
		pending: null,
		time_offset: 0,
		last_probe_at: 0,
		probe_count: 0,
		last_bind_at: 0,
		last_error: "",
		last_error_at: 0,
		last_poll_at: 0
	};
}

function load() {
	util.mkdir_p(util.RUN_DIR, 0700);
	let parsed = util.json_parse(util.read_file(PATH, ""));
	let state = defaults();
	if (type(parsed) != "object")
		return state;
	for (let key in state)
		if (parsed[key] != null)
			state[key] = parsed[key];
	return state;
}

function save(state) {
	util.mkdir_p(util.RUN_DIR, 0700);
	return util.write_atomic(PATH, util.canonical_json(state) + "\n", 0600);
}

function set_error(state, message) {
	state.last_error = util.truncate_text(util.mask_secrets(util.as_string(message)), 400);
	state.last_error_at = util.now_epoch();
}

function now() {
	return util.now_epoch();
}

return { PATH, defaults, load, save, set_error, now };
