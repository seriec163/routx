// RoutX: обновления компонентов Tachyon.
// Используем штатный CLI Tachyon, чтобы панель и LuCI видели одно и то же
// состояние и одинаковый журнал операций:
//   component_action <component> check_update   — проверить обновления
//   component_action_async <component> update   — запустить обновление
//   component_action_status <job_id>            — состояние фоновой задачи
//   component_action_log <job_id> <offset>      — журнал задачи
const run = require("jn_run");
const util = require("jn_util");

const COMPONENTS = [ "tachyon", "tachyon-core" ];

function known_component(value) {
	return index(COMPONENTS, util.as_string(value)) >= 0;
}

function parse_output(text) {
	let value = util.json_parse(util.as_string(text));
	if (type(value) == "object")
		return value;
	return null;
}

function call(args, timeout) {
	return run.run_product("tachyon", args, timeout);
}

function result_payload(res) {
	let parsed = parse_output(res.stdout);
	if (type(parsed) == "object")
		return parsed;
	return null;
}

function check_one(component) {
	let res = call([ "component_action", component, "check_update" ], 120);
	let payload = result_payload(res);
	if (payload == null) {
		let message = run.error_text(res);
		if (message == "")
			message = "пустой ответ Tachyon";
		return { ok: false, component: component, error: message };
	}
	if (payload.success === false) {
		return {
			ok: false,
			component: component,
			error: util.as_string(payload.message) || "проверка не удалась"
		};
	}
	// В Tachyon 1.7.x ядро ещё называется sing_box. Для панели это тот же
	// компонент tachyon-core, поэтому приводим имя к единому виду.
	payload.component = component;
	return { ok: true, data: payload };
}

function check() {
	let results = [];
	let errors = [];
	for (let component in COMPONENTS) {
		let item = check_one(component);
		if (item.ok) {
			push(results, item.data);
		} else {
			push(errors, { component: item.component, message: item.error });
		}
	}
	return { ok: true, results: results, errors: errors };
}

function start(component, action) {
	if (!known_component(component))
		return { ok: false, error: "Неизвестный компонент Tachyon" };
	let verb = util.as_string(action);
	if (verb == "")
		verb = "update";
	if (verb != "update" && verb != "install" && verb != "reinstall")
		return { ok: false, error: "Неподдерживаемое действие" };
	let args = [ "component_action_async", util.as_string(component), verb ];
	let res = call(args, 60);
	let payload = result_payload(res);
	if (payload == null)
		return { ok: false, error: run.error_text(res) || "Tachyon не вернул задачу" };
	if (payload.success === false)
		return { ok: false, error: util.as_string(payload.message) || "не удалось запустить обновление" };
	let job_id = util.as_string(payload.job_id);
	if (job_id == "")
		return { ok: false, error: "Tachyon не вернул идентификатор задачи" };
	return { ok: true, job_id: job_id, message: util.as_string(payload.message) };
}

function status(job_id) {
	let id = util.as_string(job_id);
	if (id == "")
		return { ok: false, error: "Не указан идентификатор задачи" };
	let res = call([ "component_action_status", id ], 30);
	let payload = result_payload(res);
	if (payload == null)
		return { ok: false, error: run.error_text(res) || "Tachyon не вернул состояние задачи" };
	return { ok: true, data: payload };
}

function log(job_id, offset) {
	let id = util.as_string(job_id);
	if (id == "")
		return { ok: false, error: "Не указан идентификатор задачи" };
	let start_offset = util.as_int(offset, 0);
	if (start_offset < 0)
		start_offset = 0;
	let res = call([ "component_action_log", id, "" + start_offset ], 30);
	let payload = result_payload(res);
	if (payload == null)
		return { ok: false, error: run.error_text(res) || "Tachyon не вернул журнал задачи" };
	return {
		ok: true,
		log: util.as_string(payload.log),
		offset: util.as_int(payload.offset, start_offset)
	};
}

function handle(args) {
	let mode = util.as_string(args.mode);
	if (mode == "check")
		return check();
	if (mode == "start")
		return start(util.as_string(args.component), util.as_string(args.action));
	if (mode == "status")
		return status(util.as_string(args.job_id));
	if (mode == "log")
		return log(util.as_string(args.job_id), util.as_int(args.offset, 0));
	return { ok: false, error: "Неизвестный режим компонента Tachyon" };
}

return { handle };
