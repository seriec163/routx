// RoutX: снимки конфигурации
const fs = require("fs");
const util = require("jn_util");
const run = require("jn_run");
const platform = require("jn_platform");

function ensure_dir() {
	util.mkdir_p(util.SNAPSHOT_DIR, 0700);
	util.mkdir_p(util.STATE_DIR, 0700);
}

function list_local() {
	ensure_dir();
	let entries = fs.lsdir(util.SNAPSHOT_DIR) || [];
	let items = [];
	for (let name in entries) {
		if (index(name, ".meta.json") >= 0)
			continue;
		if (!util.file_exists(util.SNAPSHOT_DIR + "/" + name + ".meta.json"))
			continue;
		let meta = util.json_parse(util.read_file(util.SNAPSHOT_DIR + "/" + name + ".meta.json", ""));
		if (type(meta) == "object")
			push(items, meta);
	}
	items = sort(items, function(a,b){ return (b.created_at||0) - (a.created_at||0); });
	return items;
}

function trim_local() {
	let items = list_local();
	while (length(items) > 10) {
		let old = items[10];
		// пересобираем хвост
		let keep = [];
		for (let i = 0; i < 10; i++)
			push(keep, items[i]);
		items = keep;
		if (old && old.id) {
			fs.unlink(util.SNAPSHOT_DIR + "/" + old.id);
			fs.unlink(util.SNAPSHOT_DIR + "/" + old.id + ".meta.json");
		}
		break;
	}
	// проще: обрезаем по списку
	let all = list_local();
	while (length(all) > 10) {
		let old = all[length(all) - 1];
		pop(all);
		if (old && old.id) {
			fs.unlink(util.SNAPSHOT_DIR + "/" + old.id);
			fs.unlink(util.SNAPSHOT_DIR + "/" + old.id + ".meta.json");
		}
	}
}

function snapshot_create(product, reason) {
	ensure_dir();
	let now = util.now_epoch();
	let id = "local-" + now + "-" + util.random_hex(4);

	if (product == "prokop") {
		let rreason = util.as_string(reason);
		if (rreason == "apply") rreason = "before-apply";
		let kind = rreason == "before-apply" ? "before-apply" : (rreason == "manual" ? "manual" : "automatic");
		let res = run.run_product("prokop", ["config_snapshot_create", kind], 120);
		if (!res.ok)
			return { ok: false, error: run.error_text(res) };
		let parsed = util.json_parse(res.stdout);
		if (type(parsed) != "object")
			return { ok: false, error: "неожиданный ответ prokop config_snapshot_create" };
		if (parsed.status != "created" && parsed.status != "existing")
			return { ok: false, error: parsed.reason || "ошибка создания снапшота" };
		let snap = type(parsed.snapshot) == "object" ? parsed.snapshot : {};
		return {
			ok: true,
			kind: "native",
			external_id: snap.id || id,
			sha256: snap.config_hash || "",
			size_bytes: 0,
			product_version: snap.prokop_version || "",
			raw: parsed
		};
	}

	if (product == "forkop" || product == "podkop" || product == "tachyon") {
		let src = "/etc/config/" + product;
		if (!util.file_exists(src))
			return { ok: false, error: "не найден " + src };
		let data = util.read_file(src, "");
		if (data == "")
			return { ok: false, error: "пустой " + src };
		let dst = util.SNAPSHOT_DIR + "/" + id;
		if (fs.writefile(dst, data) == null)
			return { ok: false, error: "не удалось сохранить снапшот" };
		fs.chmod(dst, 0600);
		let meta = {
			id: id,
			kind: "local",
			external_id: id,
			reason: reason == "apply" ? "before-apply" : util.as_string(reason),
			sha256: util.file_sha256(dst),
			size_bytes: util.file_size(dst),
			product_version: platform.product_version(product),
			created_at: now
		};
		util.write_atomic(util.SNAPSHOT_DIR + "/" + id + ".meta.json", util.json_string(meta) + "\n", 0600);
		trim_local();
		return { ok: true, kind: "local", external_id: id, sha256: meta.sha256, size_bytes: meta.size_bytes, product_version: meta.product_version };
	}

	return { ok: false, error: "неизвестный продукт" };
}

function snapshot_list(product) {
	if (product == "prokop") {
		let res = run.run_product("prokop", ["config_snapshot_list"], 60);
		if (!res.ok)
			return { ok: false, error: run.error_text(res) };
		let parsed = util.json_parse(res.stdout);
		if (type(parsed) != "array")
			return { ok: true, items: [] };
		return { ok: true, items: parsed };
	}
	if (product == "forkop" || product == "podkop" || product == "tachyon") {
		return { ok: true, items: list_local() };
	}
	return { ok: true, items: [] };
}

function snapshot_restore(product, snapshot_ref, kind) {
	if (product == "prokop") {
		let ref = util.as_string(snapshot_ref);
		let res = run.run_product("prokop", ["config_snapshot_restore", ref], 300);
		if (!res.ok)
			return { ok: false, error: run.error_text(res) };
		let parsed = util.json_parse(res.stdout);
		if (type(parsed) != "object")
			return { ok: false, error: "неожиданный ответ restore" };
		let status = parsed.status;
		if (status == "success" || status == "recovered")
			return { ok: true, status: status, changes: parsed.changes || [] };
		if (status == "restored_not_started")
			return { ok: true, status: status, reason: parsed.reason || "service_stopped", changes: parsed.changes || [] };
		if (status == "needs_attention")
			return { ok: false, error: parsed.reason || "требуется внимание", status: status };
		return { ok: false, error: parsed.reason || "ошибка восстановления", status: status };
	}

	if (product == "forkop" || product == "podkop" || product == "tachyon") {
		let src = util.SNAPSHOT_DIR + "/" + util.as_string(snapshot_ref);
		if (!util.file_exists(src))
			return { ok: false, error: "локальный снапшот не найден" };
		snapshot_create(product, "pre-restore");
		let data = util.read_file(src, "");
		if (data == "")
			return { ok: false, error: "пустой снапшот" };
		let dst = "/etc/config/" + product;
		if (fs.writefile(dst, data) == null)
			return { ok: false, error: "не удалось заменить " + dst };
		fs.chmod(dst, 0600);
		return { ok: true, status: "success" };
	}

	return { ok: false, error: "неизвестный продукт" };
}

return { snapshot_create, snapshot_list, snapshot_restore, list_local };
