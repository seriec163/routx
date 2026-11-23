// RoutX: замер DNS-резолверов для Prokop/Forkop.
// Работает в фоне: start запускает worker, status отдаёт прогресс, stop гасит.
// Настройки не меняет — только измеряет и возвращает рекомендации.

const fs = require("fs");
const util = require("jn_util");
const run = require("jn_run");

const STATE_DIR = "/var/run/routx-agent/dns-benchmark";
const STATE_FILE = STATE_DIR + "/state.json";
const PID_FILE = STATE_DIR + "/worker.pid";
const LIB_DIR = "/usr/lib/routx-agent";
const ROUNDS = 5;
const MAX_RESULTS = 64;
const PROBE_TIMEOUT = 4;

const DOMAINS = [
	"google.com",
	"youtube.com",
	"chatgpt.com",
	"telegram.org",
	"github.com",
	"yandex.ru",
	"cloudflare.com",
	"wikipedia.org",
	"discord.com",
	"mail.ru"
];

// filtered=true означает, что резолвер может фильтровать/блокировать домены.
// Такие серверы показываются, но в рекомендацию по умолчанию не попадают.
const UDP_CANDIDATES = [
	{ id: "yandex-77.88.8.8", provider: "Yandex", address: "77.88.8.8", filtered: false },
	{ id: "yandex-77.88.8.1", provider: "Yandex Family", address: "77.88.8.1", filtered: true },
	{ id: "cloudflare-1.1.1.1", provider: "Cloudflare", address: "1.1.1.1", filtered: false },
	{ id: "cloudflare-1.0.0.1", provider: "Cloudflare", address: "1.0.0.1", filtered: false },
	{ id: "google-8.8.8.8", provider: "Google", address: "8.8.8.8", filtered: false },
	{ id: "google-8.8.4.4", provider: "Google", address: "8.8.4.4", filtered: false },
	{ id: "quad9-9.9.9.9", provider: "Quad9", address: "9.9.9.9", filtered: false },
	{ id: "quad9-9.9.9.10", provider: "Quad9 Family", address: "9.9.9.10", filtered: true },
	{ id: "opendns-208.67.222.222", provider: "OpenDNS", address: "208.67.222.222", filtered: true },
	{ id: "comss-92.223.109.31", provider: "Comss.one", address: "92.223.109.31", filtered: false },
	{ id: "adguard-94.140.14.14", provider: "AdGuard", address: "94.140.14.14", filtered: true },
	{ id: "controld-76.76.2.0", provider: "Control D", address: "76.76.2.0", filtered: false },
	{ id: "dnssb-185.222.222.222", provider: "DNS.SB", address: "185.222.222.222", filtered: false }
];

const DOH_CANDIDATES = [
	{ id: "yandex-doh", provider: "Yandex DoH", address: "https://77.88.8.8/dns-query", ip: "77.88.8.8", filtered: false },
	{ id: "cloudflare-doh", provider: "Cloudflare DoH", address: "https://1.1.1.1/dns-query", ip: "1.1.1.1", filtered: false },
	{ id: "google-doh", provider: "Google DoH", address: "https://8.8.8.8/dns-query", ip: "8.8.8.8", filtered: false },
	{ id: "google-secondary-doh", provider: "Google DoH", address: "https://8.8.4.4/dns-query", ip: "8.8.4.4", filtered: false },
	{ id: "quad9-doh", provider: "Quad9 DoH", address: "https://9.9.9.9/dns-query", ip: "9.9.9.9", filtered: false },
	{ id: "mullvad-doh", provider: "Mullvad DoH", address: "https://dns.mullvad.net/dns-query", ip: "194.242.2.2", filtered: false },
	{ id: "dnssb-doh", provider: "DNS.SB DoH", address: "https://doh.dns.sb/dns-query", ip: "185.222.222.222", filtered: false },
	{ id: "dns4eu-doh", provider: "DNS4EU", address: "https://unfiltered.joindns4.eu/dns-query", ip: "86.54.11.100", filtered: false },
	{ id: "uncensored-doh", provider: "UncensoredDNS", address: "https://anycast.uncensoreddns.org/dns-query", ip: "", filtered: false },
	{ id: "applied-privacy-doh", provider: "Applied Privacy", address: "https://doh.applied-privacy.net/query", ip: "", filtered: false },
	{ id: "restena-doh", provider: "Restena", address: "https://dnspub.restena.lu/dns-query", ip: "", filtered: false },
	{ id: "switch-doh", provider: "SWITCH", address: "https://dns.switch.ch/dns-query", ip: "", filtered: false },
	{ id: "libredns-doh", provider: "LibreDNS", address: "https://doh.libredns.gr/dns-query", ip: "", filtered: false },
	{ id: "cira-doh", provider: "CIRA Shield", address: "https://private.canadianshield.cira.ca/dns-query", ip: "", filtered: false },
	{ id: "comss-doh", provider: "Comss.one DoH", address: "https://dns.comss.one/dns-query", ip: "92.223.109.31", filtered: false },
	{ id: "adguard-doh", provider: "AdGuard DoH", address: "https://dns.adguard-dns.com/dns-query", ip: "94.140.14.14", filtered: true },
	{ id: "controld-doh", provider: "Control D DoH", address: "https://freedns.controld.com/p0", ip: "76.76.2.0", filtered: false }
];

// Bootstrap для DoH: только IP-адреса. IP-based DoH-кандидаты не нуждаются
// в резолве hostname, но остальные кандидаты и sing-box используют этот список.
const BOOTSTRAP_SERVERS = [ "77.88.8.8", "8.8.4.4", "1.1.1.1", "9.9.9.9" ];

function now_ms() {
	let t = clock();
	return t[0] * 1000 + int(t[1] / 1000000);
}

function initial_state() {
	return {
		running: true,
		progress: 0,
		phase: "init",
		current: "",
		started_at: util.now_epoch(),
		finished_at: null,
		cancelled: false,
		error: null,
		domains: DOMAINS,
		rounds: ROUNDS,
		results: [],
		recommendations: { udp: [], doh: [] },
		bootstrap: []
	};
}

function write_state(state) {
	util.mkdir_p(STATE_DIR, 0700);
	return util.write_atomic(STATE_FILE, sprintf("%J\n", state), 0600);
}

function read_state() {
	let parsed = util.json_parse(util.read_file(STATE_FILE, ""));
	return type(parsed) == "object" ? parsed : null;
}

function pid_value() {
	let text = trim(util.as_string(util.read_file(PID_FILE, "")));
	return match(text, /^[0-9]+$/) != null ? int(text) : 0;
}

function pid_alive(pid) {
	if (int(pid) <= 0)
		return false;
	return run.run([ "kill", "-0", "" + int(pid) ], 2).ok === true;
}

function worker_running() {
	let pid = pid_value();
	return pid > 0 && pid_alive(pid);
}

function start() {
	let state = read_state();
	if (state && state.running === true && worker_running())
		return { ok: true, state: state };

	try { fs.unlink(PID_FILE); } catch (e) {}
	util.mkdir_p(STATE_DIR, 0700);
	state = initial_state();
	if (!write_state(state))
		return { ok: false, error: "не удалось сохранить состояние теста" };

	let inner = "umask 077; echo $$ > " + util.shell_quote(PID_FILE) +
		"; exec /usr/bin/ucode -L " + util.shell_quote(LIB_DIR) + " " +
		util.shell_quote(LIB_DIR + "/jn_dns_benchmark.uc") + " worker";
	let command = "setsid sh -c " + util.shell_quote(inner) + " >/dev/null 2>&1 &";
	let pipe = fs.popen(command, "r");
	if (pipe != null) {
		pipe.read("all");
		pipe.close();
	}
	return { ok: true, state: state };
}

function stop() {
	let pid = pid_value();
	if (pid > 0)
		run.run([ "kill", "-9", "" + pid ], 3);
	try { fs.unlink(PID_FILE); } catch (e) {}
	let state = read_state() || initial_state();
	state.running = false;
	state.cancelled = true;
	state.finished_at = util.now_epoch();
	state.error = "Тест остановлен пользователем";
	write_state(state);
	return { ok: true, state: state };
}

function idle_state() {
	let state = initial_state();
	state.running = false;
	state.finished_at = util.now_epoch();
	return state;
}

function status() {
	let state = read_state();
	if (!state)
		return { ok: true, state: idle_state() };
	if (state.running === true && !worker_running()) {
		state.running = false;
		state.finished_at = util.now_epoch();
		if (!state.error)
			state.error = "Worker теста DNS завершился";
		if (length(state.results || []) > 0 && !state.recommendations)
			state.recommendations = recommendations(state.results);
		write_state(state);
	}
	return { ok: true, state: state };
}

function is_ipv4(value) {
	let text = trim(util.as_string(value));
	if (match(text, /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) == null)
		return false;
	for (let part in split(text, "."))
		if (int(part) < 0 || int(part) > 255)
			return false;
	return true;
}

function dig_path() {
	for (let path in [ "/usr/bin/dig", "/usr/sbin/dig", "/bin/dig" ])
		if (fs.stat(path) != null)
			return path;
	return "";
}

function nslookup_path() {
	for (let path in [ "/usr/bin/nslookup", "/bin/nslookup", "/usr/sbin/nslookup" ])
		if (fs.stat(path) != null)
			return path;
	return "";
}

function udp_probe(server, domain) {
	let started = now_ms();
	let dig = dig_path();
	if (dig != "") {
		let res = run.run([
			dig, "@" + server, domain, "A", "+time=2", "+tries=1", "+stats"
		], PROBE_TIMEOUT);
		if (res.timed_out)
			return { ok: false, ms: null, error: "timeout" };
		let output = util.as_string(res.stdout);
		let status_match = match(output, /status:[ \t]+([A-Z]+)/);
		if (status_match == null || (status_match[1] != "NOERROR" && status_match[1] != "NXDOMAIN"))
			return { ok: false, ms: null, error: "dns" };
		let time_match = match(output, /;; Query time:[ \t]+([0-9]+)[ \t]+msec/);
		let ms = time_match != null ? int(time_match[1]) : now_ms() - started;
		return { ok: true, ms: ms >= 0 ? ms : 0, error: null };
	}

	let ns = nslookup_path();
	if (ns == "") 
		return { ok: false, ms: null, error: "no_dig_or_nslookup" };
	let res = run.run([ ns, "-timeout=2", "-type=a", domain, server ], PROBE_TIMEOUT);
	let output = util.as_string(res.stdout);
	if (res.timed_out || index(output, "timed out") >= 0 ||
	    index(output, "no servers could be reached") >= 0)
		return { ok: false, ms: null, error: "timeout" };
	if (index(output, "Name:") < 0 && index(output, "Address") < 0)
		return { ok: false, ms: null, error: "dns" };
	return { ok: true, ms: max(0, now_ms() - started), error: null };
}

function summarize(samples) {
	let values = [];
	let success = 0;
	for (let sample in samples) {
		if (sample.ok === true && sample.ms != null) {
			push(values, sample.ms);
			success++;
		} else {
			push(values, 5000);
		}
	}
	sort(values, (a, b) => a - b);
	let total = length(values);
	if (total == 0)
		return { success: 0, total: 0, loss_pct: 100, min_ms: null, median_ms: null, p95_ms: null, max_ms: null };
	let mid = int(total / 2);
	let p95 = values[min(total - 1, int(total * 0.95))];
	let sum = 0;
	for (let value in values) sum += value;
	return {
		success: success,
		total: total,
		loss_pct: int(((total - success) * 100) / total),
		min_ms: success > 0 ? values[0] : null,
		median_ms: success > 0 ? (total % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2) : null,
		p95_ms: success > 0 ? p95 : null,
		max_ms: success > 0 ? values[total - 1] : null,
		avg_ms: success > 0 ? sum / total : null
	};
}

function result_object(server, protocol, stats, error) {
	let score = stats.median_ms == null ? 99999 : stats.median_ms + stats.loss_pct * 10;
	let status_text = stats.success == 0 ? "failed" :
		stats.loss_pct == 0 ? "healthy" :
		stats.loss_pct <= 20 ? "partial" : "unstable";
	return {
		id: server.id,
		provider: server.provider,
		protocol: protocol,
		address: server.address,
		filtered: server.filtered === true,
		success: stats.success,
		total: stats.total,
		loss_pct: stats.loss_pct,
		min_ms: stats.min_ms,
		median_ms: stats.median_ms,
		p95_ms: stats.p95_ms,
		max_ms: stats.max_ms,
		avg_ms: stats.avg_ms,
		score: int(score),
		status: status_text,
		suspect: protocol == "udp" && stats.median_ms != null && stats.median_ms < 5,
		error: error || null
	};
}

function test_udp(server) {
	let precheck = udp_probe(server.address, "example.com");
	if (!precheck.ok) {
		return result_object(server, "udp",
			{ success: 0, total: 0, loss_pct: 100, min_ms: null, median_ms: null, p95_ms: null, max_ms: null, avg_ms: null },
			precheck.error);
	}
	let samples = [];
	for (let round = 0; round < ROUNDS; round++) {
		for (let domain in DOMAINS) {
			let probe = udp_probe(server.address, domain);
			push(samples, { domain: domain, ok: probe.ok, ms: probe.ms, error: probe.error });
		}
	}
	let stats = summarize(samples);
	return result_object(server, "udp", stats, stats.success == 0 ? "all_failed" : null);
}

function dns_query(domain) {
	let labels = split(replace(domain, /^\.+|\.+$/, ""), ".");
	let bytes = [ 0x42, 0x42, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 ];
	for (let label in labels) {
		if (label == "")
			continue;
		push(bytes, length(label));
		for (let i = 0; i < length(label); i++)
			push(bytes, ord(label, i));
	}
	push(bytes, 0x00, 0x00, 0x01, 0x00, 0x01);
	let raw = "";
	for (let byte in bytes)
		raw += sprintf("%c", byte);
	return raw;
}

function b64url(value) {
	return replace(replace(replace(b64enc(value), /\+/g, "-"), /\//g, "_"), /=+$/, "");
}

function u16(data, offset) {
	return ord(data, offset) * 256 + ord(data, offset + 1);
}

function valid_answer(body, query) {
	if (type(body) != "string" || length(body) < 12 || length(query) < 12)
		return false;
	if (substr(body, 0, 2) != substr(query, 0, 2))
		return false;
	if ((ord(body, 2) & 0x80) == 0)
		return false;
	let rcode = ord(body, 3) & 0x0f;
	if (rcode != 0 && rcode != 3)
		return false;
	if (u16(body, 4) != 1)
		return false;
	if (substr(body, 12, length(query) - 12) != substr(query, 12))
		return false;
	return true;
}

let resolved_hosts = {};

function resolve_host(host, bootstrap) {
	if (is_ipv4(host))
		return host;
	if (resolved_hosts[host] != null)
		return resolved_hosts[host] != "" ? resolved_hosts[host] : null;
	let dig = dig_path();
	let ns = nslookup_path();
	for (let server in bootstrap) {
		server = util.as_string(server);
		if (!is_ipv4(server))
			continue;
		if (dig != "") {
			let res = run.run([ dig, "@" + server, host, "A", "+short", "+time=2", "+tries=1" ], PROBE_TIMEOUT);
			for (let line in split(util.as_string(res.stdout), "\n")) {
				line = trim(line);
				if (is_ipv4(line)) {
					resolved_hosts[host] = line;
					return line;
				}
			}
		}
		if (ns != "") {
			let res = run.run([ ns, "-timeout=2", "-type=a", host, server ], PROBE_TIMEOUT);
			for (let line in split(util.as_string(res.stdout), "\n")) {
				let m = match(line, /Address[^:]*:[ \t]+([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/);
				if (m != null && m[1] != server && is_ipv4(m[1])) {
					resolved_hosts[host] = m[1];
					return m[1];
				}
			}
		}
	}
	resolved_hosts[host] = "";
	return null;
}

function doh_host(path) {
	let m = match(util.as_string(path), /^https:\/\/([^/:]+)(:([0-9]+))?/);
	return m != null ? { host: m[1], port: m[3] != null ? int(m[3]) : 443 } : null;
}

function curl_path() {
	for (let path in [ "/usr/bin/curl", "/bin/curl", "/usr/sbin/curl" ])
		if (fs.stat(path) != null)
			return path;
	return "";
}

function doh_measure(server, bootstrap, domains, rounds) {
	let parsed = doh_host(server.address);
	if (parsed == null)
		return null;
	let host = parsed.host;
	let port = parsed.port;
	let ip = is_ipv4(server.ip) ? server.ip : resolve_host(host, bootstrap);
	if (ip == null || ip == "")
		return null;
	let curl = curl_path();
	if (curl == "")
		return null;

	domains = type(domains) == "array" && length(domains) > 0 ? domains : DOMAINS;
	rounds = int(rounds) > 0 ? int(rounds) : ROUNDS;
	let count = length(domains) * rounds;
	let args = [
		curl, "--disable", "--silent", "--globoff", "--noproxy", "*",
		"--proto", "=https", "--tlsv1.2", "--connect-timeout", "4", "--max-time", "4",
		"--max-filesize", "65535", "--header", "accept: application/dns-message",
		"--header", "cache-control: no-cache", "--resolve", host + ":" + port + ":" + ip
	];
	let files = [];
	for (let i = 0; i < count; i++) {
		let domain = domains[i % length(domains)];
		let query = dns_query(domain);
		let file = STATE_DIR + "/doh-" + server.id + "-" + i + ".bin";
		push(files, { path: file, query: query, domain: domain });
		if (i > 0) push(args, "--next");
		push(args, "--output"); push(args, file);
		push(args, "--write-out", "" + i + "|%{http_code}|%{time_total}|%{content_type}|%{size_download}|%{exitcode}\n");
		push(args, "--url", server.address + (index(server.address, "?") >= 0 ? "&" : "?") + "dns=" + b64url(query));
	}
	let res = run.run(args, min(300, count * 6 + 20));
	let reports = {};
	for (let line in split(util.as_string(res.stdout), "\n")) {
		let parts = split(line, "|");
		if (length(parts) == 6 && match(parts[0], /^[0-9]+$/) != null)
			reports[int(parts[0])] = parts;
	}
	let samples = [];
	for (let i = 0; i < count; i++) {
		let item = files[i];
		let body = util.read_file(item.path, "");
		try { fs.unlink(item.path); } catch (e) {}
		let report = reports[i];
		let ok = report != null && report[1] == "200" && report[5] == "0" &&
			index(lc(util.as_string(report[3])), "application/dns-message") >= 0 &&
			int(report[4]) == length(body) && valid_answer(body, item.query);
		let error = null;
		if (!ok) {
			if (report == null)
				error = "probe";
			else if (report[5] == "60")
				error = "tls";
			else if (report[5] != "0")
				error = int(report[5]) == 28 ? "timeout" : "transport";
			else if (report[1] != "200")
				error = "http";
			else
				error = "dns";
		}
		push(samples, { domain: item.domain, ok: ok, ms: ok ? (report[2] * 1.0) * 1000 : null, error: error });
	}
	return summarize(samples);
}

function test_doh(server, bootstrap) {
	let empty = { success: 0, total: 0, loss_pct: 100, min_ms: null, median_ms: null, p95_ms: null, max_ms: null, avg_ms: null };
	let precheck = doh_measure({ ...server, id: server.id + "-precheck" }, bootstrap, [ "example.com" ], 1);
	if (precheck == null || precheck.success === 0)
		return result_object(server, "doh", empty, "precheck_failed");
	let stats = doh_measure(server, bootstrap, DOMAINS, ROUNDS);
	if (stats == null)
		return result_object(server, "doh", empty, "unresolved_or_no_curl");
	return result_object(server, "doh", stats, stats.success == 0 ? "all_failed" : null);
}

function sort_results(results) {
	return sort(results, (a, b) => {
		if (a.median_ms == null && b.median_ms == null) return a.provider < b.provider ? -1 : 1;
		if (a.median_ms == null) return 1;
		if (b.median_ms == null) return -1;
		return a.median_ms - b.median_ms;
	});
}

function top_for(results, protocol) {
	let working = [];
	for (let item in results)
		if (item.protocol == protocol && item.filtered !== true && item.suspect !== true &&
		    item.success > 0 && item.loss_pct <= 20 && item.median_ms != null)
			push(working, item);
	working = sort_results(working);
	let limit = protocol == "doh" ? 3 : 2;
	let selected = [];
	let providers = {};
	for (let item in working) {
		if (length(selected) >= limit) break;
		if (!providers[item.provider]) {
			providers[item.provider] = true;
			push(selected, item);
		}
	}
	if (length(selected) < limit) {
		for (let item in working) {
			if (length(selected) >= limit) break;
			let seen = false;
			for (let chosen in selected)
				if (chosen.address == item.address) seen = true;
			if (!seen) push(selected, item);
		}
	}
	return selected;
}

function recommendations(results) {
	return {
		udp: top_for(results, "udp"),
		doh: top_for(results, "doh")
	};
}

function choose_bootstrap(results) {
	// Пользовательский набор bootstrap: стабильные IP-адреса. Результаты
	// бенчмарка оставляем для рекомендаций, но bootstrap не зависит от того,
	// какой UDP-сервер оказался самым быстрым в этот раз.
	let ips = [];
	for (let ip in BOOTSTRAP_SERVERS)
		if (index(ips, ip) < 0)
			push(ips, ip);
	return ips;
}

function run_worker() {
	let state = initial_state();
	write_state(state);
	let results = [];
	try {
		let total = length(UDP_CANDIDATES) + length(DOH_CANDIDATES);
		let done = 0;
		for (let server in UDP_CANDIDATES) {
			state.phase = "udp";
			state.current = server.provider;
			let result = test_udp(server);
			push(results, result);
			state.results = results;
			done++;
			state.progress = int((done * 100) / total);
			write_state(state);
		}

		let bootstrap = choose_bootstrap(results);
		state.bootstrap = bootstrap;
		write_state(state);

		for (let server in DOH_CANDIDATES) {
			state.phase = "doh";
			state.current = server.provider;
			let result = test_doh(server, bootstrap);
			push(results, result);
			state.results = results;
			done++;
			state.progress = int((done * 100) / total);
			write_state(state);
		}

		state.results = sort_results(results);
		state.recommendations = recommendations(state.results);
		state.running = false;
		state.progress = 100;
		state.phase = "done";
		state.current = "Готово";
		state.finished_at = util.now_epoch();
		write_state(state);
	} catch (e) {
		state.running = false;
		state.finished_at = util.now_epoch();
		state.error = util.as_string(e);
		state.results = state.results || [];
		if (length(state.results) > 0)
			state.recommendations = recommendations(state.results);
		write_state(state);
	}
	try { fs.unlink(PID_FILE); } catch (e) {}
	return 0;
}

function handle(mode) {
	let action = util.as_string(mode);
	if (action == "start")
		return start();
	if (action == "status")
		return status();
	if (action == "stop")
		return stop();
	return { ok: false, error: "неизвестный режим DNS-бенчмарка" };
}

if (sourcepath(1) != null && sourcepath(1) != "")
	return { handle: handle };

if (ARGV[0] == "worker")
	exit(run_worker());

print(sprintf("%J\n", handle(ARGV[0])));
exit(0);
