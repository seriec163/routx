// RoutX: диагностика
const util = require("jn_util");
const platform = require("jn_platform");
const run = require("jn_run");

function check_state(name, ok, details) {
	return { name: name, state: ok ? "ok" : "error", details: details || "" };
}

function diagnostics_quick(product) {
	let report = {
		kind: "quick",
		product: product,
		generated_at: util.iso_now(),
		checks: []
	};

	let ui = platform.get_ui_state(product);
	let ui_vals = platform.ui_state_values(product, ui);
	push(report.checks, check_state("service_status", ui_vals.health.overall == "ok" || ui_vals.health.overall == "degraded",
		"overall=" + ui_vals.health.overall));

	let reasons = [];
	if (!ui_vals.health.dns_configured)
		push(reasons, "DNS не настроен");

	push(report.checks, {
		name: product + "_service",
		state: !ui_vals.health.product_running ? "error" : (ui_vals.health.product_enabled ? "ok" : "warning"),
		details: !ui_vals.health.product_running ? "не запущен" :
			(ui_vals.health.product_enabled ? "запущен, автозапуск включён" : "запущен, автозапуск отключён")
	});
	push(report.checks, {
		name: "sing_box_service",
		state: !ui_vals.health.sing_box_running ? "error" :
			(ui_vals.health.sing_box_managed || ui_vals.health.sing_box_enabled ? "ok" : "warning"),
		details: !ui_vals.health.sing_box_running ? "не запущен" :
			(ui_vals.health.sing_box_managed ? "запущен, автозапуск через " + (product == "forkop" ? "Forkop" : (product == "podkop" ? "Podkop" : (product == "tachyon" ? "Tachyon" : "Prokop"))) :
				(ui_vals.health.sing_box_enabled ? "запущен, автозапуск включён" : "запущен, автозапуск отключён"))
	});

	if (product == "prokop" || product == "forkop") {
		let hs = run.run_product(product, ["get_health_status"], 20);
		if (hs.ok) {
			let h = util.json_parse(hs.stdout);
			if (type(h) == "object") {
				let overall = util.as_string(h.overall);
				if (overall != "" && overall != "ok")
					push(reasons, "общее состояние: " + overall);
				let svc = type(h.service) == "object" ? h.service : {};
				for (let name in [ "prokop", "sing_box" ]) {
					let value = util.as_string(svc[name]);
					if (value != "" && value != "ok")
						push(reasons, name + ": " + value);
				}
				let dns = type(h.dns) == "object" ? h.dns : {};
				let dns_status = util.as_string(dns.status);
				if (dns_status != "" && dns_status != "ok" && dns_status != "unknown")
					push(reasons, "DNS: " + dns_status);
				let dpi = type(h.dpi) == "object" ? h.dpi : {};
				let dpi_status = util.as_string(dpi.status);
				if (dpi_status != "" && dpi_status != "ok" && dpi_status != "unknown")
					push(reasons, "DPI: " + dpi_status);
				let lists = type(h.lists) == "object" ? h.lists : {};
				let lists_status = util.as_string(lists.status);
				if (lists_status != "" && lists_status != "ok" && lists_status != "unknown")
					push(reasons, "списки: " + lists_status);
				let guard = type(h.guard) == "object" ? h.guard : {};
				if (util.is_true(guard.active))
					push(reasons, "аварийный guard активен");
				let recovery = type(h.recovery) == "object" ? h.recovery : {};
				if (util.is_true(recovery.pending))
					push(reasons, "ожидается восстановление");
				let reload = type(h.reload) == "object" ? h.reload : {};
				if (util.is_true(reload.busy))
					push(reasons, "идёт перезагрузка конфигурации");
				let bridge = type(h.bridge_netfilter) == "object" ? h.bridge_netfilter : {};
				let bridge_status = util.as_string(bridge.status);
				if (bridge_status != "" && bridge_status != "ok" && bridge_status != "unknown")
					push(reasons, "bridge netfilter: " + bridge_status);
				let package_recovery = type(h.package_recovery) == "object" ? h.package_recovery : {};
				if (util.is_true(package_recovery.pending))
					push(reasons, "ожидается восстановление пакетов");
			}
		}
	}

	push(report.checks, {
		name: "health_reasons",
		state: length(reasons) > 0 ? "warning" : "ok",
		details: length(reasons) > 0 ? join("; ", reasons) : "других замечаний нет"
	});

	let sb = platform.sing_box_info(product);
	push(report.checks, check_state("sing_box_version", sb.version != "",
		sb.version != "" ? sb.version : "не определена"));

	if (product == "prokop") {
		let res = run.run_product("prokop", ["get_status"], 20);
		push(report.checks, check_state("prokop_get_status", res.ok, res.ok ? "ok" : run.error_text(res)));
	} else if (product == "forkop") {
		let res = run.run_product("forkop", ["get_status"], 20);
		push(report.checks, check_state("forkop_get_status", res.ok, res.ok ? "ok" : run.error_text(res)));
	} else if (product == "tachyon") {
		let res = run.run_product("tachyon", ["get_status"], 20);
		push(report.checks, check_state("tachyon_get_status", res.ok, res.ok ? "ok" : run.error_text(res)));
	} else if (product == "podkop") {
		let res = run.run_product("podkop", ["get_status"], 20);
		push(report.checks, check_state("podkop_get_status", res.ok, res.ok ? "ok" : run.error_text(res)));
	} else {
		push(report.checks, { name: "product", state: "not_available", details: "продукт не определён" });
	}

	let text = util.mask_secrets(util.json_string(report));
	return { report: report, text: text };
}

function diagnostics_full(product) {
	let report = diagnostics_quick(product).report;
	report.kind = "full";
	push(report.checks, { name: "platform", state: "ok", details: platform.openwrt_version() + "/" + platform.arch() });
	if (product == "prokop") {
		let res = run.run_product("prokop", ["global_check", "masked", "masked"], 180);
		if (res.ok) {
			push(report.checks, { name: "global_check", state: "ok", details: util.truncate_text(res.stdout, 60000) });
		} else {
			push(report.checks, { name: "global_check", state: "error", details: run.error_text(res) });
		}
	} else if (product == "podkop") {
		let res = run.run_product("podkop", ["global_check"], 180);
		if (res.ok) {
			push(report.checks, { name: "global_check", state: "ok", details: util.truncate_text(res.stdout, 60000) });
		} else {
			push(report.checks, { name: "global_check", state: "error", details: run.error_text(res) });
		}
	} else if (product == "tachyon") {
		let status = run.run_product("tachyon", [ "get_status" ], 15);
		push(report.checks, {
			name: "tachyon_get_status",
			state: status.ok ? "ok" : "error",
			details: status.ok ? util.truncate_text(status.stdout, 4000) : run.error_text(status)
		});
		let service = run.run_product("tachyon", [ "get_sing_box_status" ], 20);
		push(report.checks, {
			name: "tachyon_sing_box_status",
			state: service.ok ? "ok" : "warning",
			details: service.ok ? util.truncate_text(service.stdout, 8000) : run.error_text(service)
		});
		let proxies = run.run_product("tachyon", [ "clash_api", "get_proxies" ], 30);
		push(report.checks, {
			name: "tachyon_proxies",
			state: proxies.ok ? "ok" : "error",
			details: proxies.ok ? util.truncate_text(proxies.stdout, 20000) : run.error_text(proxies)
		});
		let logs = run.run([ "sh", "-c", "logread -e tachyon | tail -n 250" ], 20);
		push(report.checks, {
			name: "tachyon_logs",
			state: logs.ok ? "ok" : "warning",
			details: logs.ok ? util.truncate_text(util.mask_secrets(logs.stdout), 30000) : run.error_text(logs)
		});
		let sb_logs = run.run([ "sh", "-c", "logread -e sing-box | tail -n 150" ], 20);
		push(report.checks, {
			name: "sing_box_logs",
			state: sb_logs.ok ? "ok" : "warning",
			details: sb_logs.ok ? util.truncate_text(util.mask_secrets(sb_logs.stdout), 30000) : run.error_text(sb_logs)
		});
	} else {
		push(report.checks, { name: "global_check", state: "not_available", details: "доступно только для Prokop/Podkop" });
	}
	let text = util.mask_secrets(util.json_string(report));
	return { report: report, text: text };
}

return { diagnostics_quick, diagnostics_full };
