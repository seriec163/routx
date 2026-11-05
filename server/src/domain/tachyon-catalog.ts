/**
 * Каталог списков Dushnilin/tachyon-lists.
 *
 * Сгенерировано scripts/sync-tachyon-lists.mjs.
 * Не редактировать вручную — обновите каталог и запустите скрипт снова.
 *
 * Источник: https://github.com/Dushnilin/tachyon-lists
 * Версия каталога: 1
 * Сгенерирован: 2026-11-04T23:39:12Z
 */

export interface TachyonListCounts {
  domain: number;
  domain_suffix: number;
  domain_keyword: number;
  domain_regex: number;
  ipv4_cidr: number;
  ipv6_cidr: number;
}

export interface TachyonListFiles {
  trs: string | null;
  srs: string | null;
  json: string | null;
  domains: string | null;
  subnets: string | null;
}

export interface TachyonList {
  id: string;
  group: string;
  kind: string;
  recommended_action: string;
  title: string;
  description: string;
  counts: TachyonListCounts;
  files: TachyonListFiles;
  fallback_srs: string | null;
}

export const TACHYON_CATALOG_GENERATED_AT = "2026-11-04T23:39:12Z";
export const TACHYON_CATALOG_VERSION = 1;
export const TACHYON_CATALOG: TachyonList[] = [
  {
    "id": "russia_inside",
    "group": "regional",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Россия (внутри) — сводный набор регионально ограниченных в РФ ресурсов",
    "description": "[Маршрут: В Прокси / VPN или Desync] Главный сводный список селективной маршрутизации внутри России: объединяет региональные базы доменов, списки Re:filter, Antifilter и популярные зарубежные сервисы, ограничившие доступ для российских IP.",
    "counts": {
      "domain": 0,
      "domain_suffix": 73173,
      "domain_keyword": 105,
      "domain_regex": 5,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/russia_inside.trs",
      "srs": "release/sing-box/russia_inside.srs",
      "json": "release/json/russia_inside.json",
      "domains": "release/domains/russia_inside.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/russia_inside.srs"
  },
  {
    "id": "geoblock",
    "group": "regional",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Геоблок — зарубежные сервисы, закрывшие доступ с российских IP",
    "description": "[Маршрут: Только в Прокси / VPN — геоблок по IP] Единая база из 150+ иностранных платформ, SaaS, банков и облаков, возвращающих ошибку 403 / Unavailable in your region из РФ: PayPal, Wise, Revolut, Notion, Canva, Trello, Jira, Atlassian, Zoom, Intel, Dell, Broadcom, VMware, Coursera, Udemy, JetBrains, GitLab, Adobe, Autodesk, Grammarly, Medium, Docker, DigiCert и др.",
    "counts": {
      "domain": 0,
      "domain_suffix": 968,
      "domain_keyword": 105,
      "domain_regex": 5,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/geoblock.trs",
      "srs": "release/sing-box/geoblock.srs",
      "json": "release/json/geoblock.json",
      "domains": "release/domains/geoblock.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/geoblock.srs"
  },
  {
    "id": "block",
    "group": "regional",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Базовый региональный список (block) — домены с прямыми сетевыми ограничениями",
    "description": "[Маршрут: В Прокси / VPN или Desync] Сайты и внешние веб-ресурсы из базовой региональной выгрузки, недоступные при прямом подключении через локальных провайдеров.",
    "counts": {
      "domain": 0,
      "domain_suffix": 331,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/block.trs",
      "srs": "release/sing-box/block.srs",
      "json": "release/json/block.json",
      "domains": "release/domains/block.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/block.srs"
  },
  {
    "id": "ru_blocked",
    "group": "regional",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Региональный список RU (очищенный) — актуальные домены с ограниченным доступом",
    "description": "[Маршрут: В Прокси / VPN или Desync] Очищенный и дедуплицированный список реально действующих доменов с региональными ограничениями в РФ (без неактивных и устаревших записей).",
    "counts": {
      "domain": 0,
      "domain_suffix": 73515,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 88587,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/ru_blocked.trs",
      "srs": "release/sing-box/ru_blocked.srs",
      "json": "release/json/ru_blocked.json",
      "domains": "release/domains/ru_blocked.lst",
      "subnets": "release/subnets/ru_blocked.lst"
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-ru-blocked.srs"
  },
  {
    "id": "ru_blocked_all",
    "group": "regional",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Региональный список RU (полный) — все домены, поддомены и зеркала",
    "description": "[Маршрут: В Прокси / VPN или Desync] Полная нефильтрованная выгрузка всех доменов, поддоменов и зеркал из региональных списков маршрутизации РФ.",
    "counts": {
      "domain": 0,
      "domain_suffix": 1587644,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 916,
      "ipv6_cidr": 4
    },
    "files": {
      "trs": "release/tachyon/ru_blocked_all.trs",
      "srs": "release/sing-box/ru_blocked_all.srs",
      "json": "release/json/ru_blocked_all.json",
      "domains": "release/domains/ru_blocked_all.lst",
      "subnets": "release/subnets/ru_blocked_all.lst"
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-ru-blocked-all.srs"
  },
  {
    "id": "antifilter",
    "group": "regional",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Antifilter Community — сводный список маршрутизации сообщества",
    "description": "[Маршрут: В Прокси / VPN или Desync] Курируемый сообществом Antifilter.download список доменов и подсетей зарубежных сервисов для селективной маршрутизации.",
    "counts": {
      "domain": 0,
      "domain_suffix": 421,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 916,
      "ipv6_cidr": 4
    },
    "files": {
      "trs": "release/tachyon/antifilter.trs",
      "srs": "release/sing-box/antifilter.srs",
      "json": "release/json/antifilter.json",
      "domains": "release/domains/antifilter.lst",
      "subnets": "release/subnets/antifilter.lst"
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-antifilter-download-community.srs"
  },
  {
    "id": "refilter",
    "group": "regional",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Re:filter — выверенный список региональных маршрутов и геоблока без лишних доменов",
    "description": "[Маршрут: В Прокси / VPN] Тщательно модерируемый проект Re:filter: включает проверенные домены зарубежных ресурсов и сервисов с геоблоком без избыточных правил.",
    "counts": {
      "domain": 0,
      "domain_suffix": 73438,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 25391,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/refilter.trs",
      "srs": "release/sing-box/refilter.srs",
      "json": "release/json/refilter.json",
      "domains": "release/domains/refilter.lst",
      "subnets": "release/subnets/refilter.lst"
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-refilter.srs"
  },
  {
    "id": "russia_outside",
    "group": "regional",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Россия (снаружи) — сервисы РФ для доступа из-за рубежа",
    "description": "[Маршрут: В Прокси с IP РФ (из-за рубежа) или Direct (в РФ)] Российские банки, Госуслуги, маркетплейсы (Ozon, Wildberries), онлайн-кинотеатры (Кинопоиск, Иви, Wink, Okko) и госсайты, не открывающиеся с зарубежных IP-адресов.",
    "counts": {
      "domain": 0,
      "domain_suffix": 176,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/russia_outside.trs",
      "srs": "release/sing-box/russia_outside.srs",
      "json": "release/json/russia_outside.json",
      "domains": "release/domains/russia_outside.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/russia_outside.srs"
  },
  {
    "id": "ukraine_inside",
    "group": "regional",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Украина (внутри) — российские сервисы, соцсети, банки и ресурсы с региональными ограничениями",
    "description": "[Маршрут: В Прокси / VPN] Российские сайты, экосистемы (Яндекс, VK, Одноклассники, Mail.ru, Дзен, Кинопоиск, Rutube), банки (Сбер, Т-Банк, ВТБ, Альфа), маркетплейсы (Ozon, Wildberries, Авито), Госуслуги, СМИ и CDN с региональными ограничениями маршрутизации.",
    "counts": {
      "domain": 0,
      "domain_suffix": 1858,
      "domain_keyword": 9,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/ukraine_inside.trs",
      "srs": "release/sing-box/ukraine_inside.srs",
      "json": "release/json/ukraine_inside.json",
      "domains": "release/domains/ukraine_inside.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/ukraine_inside.srs"
  },
  {
    "id": "belarus_inside",
    "group": "regional",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Беларусь (внутри) — региональный набор сайтов, медиа и зарубежных платформ",
    "description": "[Маршрут: В Прокси / VPN или Desync] Сводный список интернет-ресурсов, новостных порталов и зарубежных платформ с региональными ограничениями доступа в РБ (включая закрытые по геоблоку LinkedIn, ChatGPT, Claude, Airbnb, Upwork, Coursera).",
    "counts": {
      "domain": 0,
      "domain_suffix": 81,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/belarus_inside.trs",
      "srs": "release/sing-box/belarus_inside.srs",
      "json": "release/json/belarus_inside.json",
      "domains": "release/domains/belarus_inside.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/Dushnilin/tachyon-lists/releases/latest/download/belarus_inside.srs"
  },
  {
    "id": "ru_whitelist",
    "group": "direct",
    "kind": "domains",
    "recommended_action": "direct",
    "title": "Белый список РФ (Direct) — Госуслуги, банки, маркетплейсы, капчи и госсайты",
    "description": "[Маршрут: Напрямую (Direct)] Критически важные российские сервисы, которые нельзя пускать через VPN: Госуслуги, ФНС (nalog.ru), Честный ЗНАК, Мос.ру, Сбербанк, Т-Банк, Альфа-Банк, ВТБ, Ozon, Wildberries, Авито, Яндекс, VK, РЖД, корневые сертификаты и проверочные домены.",
    "counts": {
      "domain": 0,
      "domain_suffix": 456,
      "domain_keyword": 9,
      "domain_regex": 0,
      "ipv4_cidr": 6710,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/ru_whitelist.trs",
      "srs": "release/sing-box/ru_whitelist.srs",
      "json": "release/json/ru_whitelist.json",
      "domains": "release/domains/ru_whitelist.lst",
      "subnets": "release/subnets/ru_whitelist.lst"
    },
    "fallback_srs": "https://raw.githubusercontent.com/hydraponique/roscomvpn-geosite/master/release/sing-box/whitelist.srs"
  },
  {
    "id": "ru_domains",
    "group": "direct",
    "kind": "domains",
    "recommended_action": "direct",
    "title": "Рунет и СНГ (Direct) — доменные зоны .ru, .рф, .su, .by, .kz и компании РФ",
    "description": "[Маршрут: Напрямую (Direct)] Все национальные доменные зоны России и СНГ (.ru, .рф, .su, .рус, .москва, .дети, .татар, .by, .бел, .kz, .қаз), а также международные домены российских компаний (Яндекс, VK, Mail.ru, Kaspersky, 1С, 2ГИС, Rutube).",
    "counts": {
      "domain": 3,
      "domain_suffix": 890,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 36604,
      "ipv6_cidr": 89
    },
    "files": {
      "trs": "release/tachyon/ru_domains.trs",
      "srs": "release/sing-box/ru_domains.srs",
      "json": "release/json/ru_domains.json",
      "domains": "release/domains/ru_domains.lst",
      "subnets": "release/subnets/ru_domains.lst"
    },
    "fallback_srs": "https://raw.githubusercontent.com/hydraponique/roscomvpn-geosite/master/release/sing-box/category-ru.srs"
  },
  {
    "id": "ru_only_inside",
    "group": "direct",
    "kind": "domains",
    "recommended_action": "direct",
    "title": "Только из РФ (Direct) — госпорталы, банки и сервисы, блокирующие VPN IP",
    "description": "[Маршрут: Строго Напрямую (Direct)] Российские государственные порталы, банки, суды, ЕМИАС, региональные сервисы ЖКХ и операторы связи, которые жёстко блокируют вход с любых зарубежных и серверных IP-адресов.",
    "counts": {
      "domain": 0,
      "domain_suffix": 170,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/ru_only_inside.trs",
      "srs": "release/sing-box/ru_only_inside.srs",
      "json": "release/json/ru_only_inside.json",
      "domains": "release/domains/ru_only_inside.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-ru-available-only-inside.srs"
  },
  {
    "id": "push",
    "group": "direct",
    "kind": "domains",
    "recommended_action": "direct",
    "title": "Push-уведомления (Direct) — Apple APNs, Google FCM, Huawei, Xiaomi, Samsung",
    "description": "[Маршрут: Напрямую (Direct)] Серверы доставки мобильных и системных push-уведомлений: Apple APNs (push.apple.com), Google FCM (mtalk.google.com, fcm.googleapis.com), Huawei Push, Xiaomi MiPush, Samsung Push и Windows WNS.",
    "counts": {
      "domain": 0,
      "domain_suffix": 17,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/push.trs",
      "srs": "release/sing-box/push.srs",
      "json": "release/json/push.json",
      "domains": "release/domains/push.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/hydraponique/roscomvpn-geosite/master/release/sing-box/push.srs"
  },
  {
    "id": "steam_cdn",
    "group": "direct",
    "kind": "domains",
    "recommended_action": "direct",
    "title": "Steam CDN и загрузка игр (Direct) — скачивание игр и патчей напрямую мимо VPN",
    "description": "[Маршрут: Напрямую (Direct) — ставить выше правила Steam] Контент-серверы скачивания игр и обновлений Steam (steamcontent.com, steampipe.akamaized.net, dl.steam.ksyna.com, steamserver.net) и других игровых лаунчеров. Поставьте этот список в Direct выше основного списка Steam (Proxy): магазин, смена региона, инвентарь и торговая площадка будут работать через VPN, а 100-гигабайтные игры будут качаться напрямую на полной скорости вашего провайдера.",
    "counts": {
      "domain": 71,
      "domain_suffix": 29,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/steam_cdn.trs",
      "srs": "release/sing-box/steam_cdn.srs",
      "json": "release/json/steam_cdn.json",
      "domains": "release/domains/steam_cdn.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/category-game-platforms-download.srs"
  },
  {
    "id": "captive_ntp_stun",
    "group": "direct",
    "kind": "domains",
    "recommended_action": "direct",
    "title": "Captive Portal, NTP и STUN (Direct) — проверка интернета, точное время и NAT-проброс",
    "description": "[Маршрут: Напрямую (Direct)] Системные домены проверки наличия интернета на iOS, Android, Windows и macOS (captive.apple.com, connectivitycheck.gstatic.com, msftconnecttest.com), серверы синхронизации точного времени NTP (pool.ntp.org, time.cloudflare.com — критично для запуска VLESS/Reality и WireGuard на роутерах без RTC) и публичные STUN-серверы.",
    "counts": {
      "domain": 409,
      "domain_suffix": 87,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/captive_ntp_stun.trs",
      "srs": "release/sing-box/captive_ntp_stun.srs",
      "json": "release/json/captive_ntp_stun.json",
      "domains": "release/domains/captive_ntp_stun.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/category-ntp.srs"
  },
  {
    "id": "ai_all",
    "group": "ai",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Нейросети и ИИ (все) — OpenAI, Claude, Gemini, Grok, OpenRouter, OpenCode, Cursor, Perplexity, DeepSeek",
    "description": "[Маршрут: Только в Прокси / VPN — геоблок по IP] Единый полный список всех зарубежных ИИ-сервисов и инструментов разработки: OpenAI (ChatGPT, Sora), Anthropic (Claude, Claude Code), Google (Gemini, AI Studio, NotebookLM, Antigravity), xAI (Grok), OpenRouter, OpenCode, Cursor, Windsurf, Codeium, Perplexity, GitHub/MS Copilot, JetBrains AI, DeepSeek, Midjourney, Civitai, ElevenLabs, Suno, Udio, Runway, Kling, Hugging Face, Poe, Groq и Mistral.",
    "counts": {
      "domain": 20,
      "domain_suffix": 330,
      "domain_keyword": 0,
      "domain_regex": 1,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/ai_all.trs",
      "srs": "release/sing-box/ai_all.srs",
      "json": "release/json/ai_all.json",
      "domains": "release/domains/ai_all.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-category-ai-!cn.srs"
  },
  {
    "id": "openai",
    "group": "ai",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "OpenAI — ChatGPT, Sora, GPT API, o1/o3 и CDN-ресурсы",
    "description": "[Маршрут: Только в Прокси / VPN — геоблок по IP] Все домены и поддомены OpenAI: chatgpt.com, chat.openai.com, sora.com, platform.openai.com, api.openai.com, oaistatic.com, oaiusercontent.com и шлюзы авторизации.",
    "counts": {
      "domain": 10,
      "domain_suffix": 14,
      "domain_keyword": 0,
      "domain_regex": 1,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/openai.trs",
      "srs": "release/sing-box/openai.srs",
      "json": "release/json/openai.json",
      "domains": "release/domains/openai.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-openai.srs"
  },
  {
    "id": "anthropic",
    "group": "ai",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Anthropic — Claude AI, Claude Code, Console и API",
    "description": "[Маршрут: Только в Прокси / VPN — геоблок по IP] Домены нейросети Claude и инструментов разработки Anthropic: claude.ai, claude.com, anthropic.com, console.anthropic.com, api.anthropic.com, claudeusercontent.com, claudemcpclient.com и CDN.",
    "counts": {
      "domain": 1,
      "domain_suffix": 18,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/anthropic.trs",
      "srs": "release/sing-box/anthropic.srs",
      "json": "release/json/anthropic.json",
      "domains": "release/domains/anthropic.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-anthropic.srs"
  },
  {
    "id": "google_ai",
    "group": "ai",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Google AI — Gemini, AI Studio, NotebookLM, Antigravity, Jules, DeepMind и Vertex AI",
    "description": "[Маршрут: Только в Прокси / VPN — геоблок по IP] Все домены ИИ-экосистемы Google: gemini.google.com, aistudio.google.com, notebooklm.google.com, antigravity.google, jules.google, stitch.withgoogle.com, labs.google, deepmind.google и generativelanguage.googleapis.com.",
    "counts": {
      "domain": 3,
      "domain_suffix": 55,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/google_ai.trs",
      "srs": "release/sing-box/google_ai.srs",
      "json": "release/json/google_ai.json",
      "domains": "release/domains/google_ai.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/google_ai.srs"
  },
  {
    "id": "xai",
    "group": "ai",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "xAI — нейросеть Grok (grok.com, x.ai и API)",
    "description": "[Маршрут: Только в Прокси / VPN — геоблок по IP] Домены искусственного интеллекта xAI Илона Маска: grok.com, x.ai, console.x.ai, api.x.ai, grokusercontent.com и медиа-CDN Grok.",
    "counts": {
      "domain": 0,
      "domain_suffix": 5,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/xai.trs",
      "srs": "release/sing-box/xai.srs",
      "json": "release/json/xai.json",
      "domains": "release/domains/xai.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-xai.srs"
  },
  {
    "id": "openrouter",
    "group": "ai",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "OpenRouter, Poe, Groq и Mistral — единые LLM API-шлюзы и быстрый облачный инференс",
    "description": "[Маршрут: Только в Прокси / VPN — геоблок по IP] Агрегаторы нейросетей и провайдеры облачного инференса: OpenRouter (openrouter.ai), Poe (poe.com), Groq (groq.com), Mistral AI (mistral.ai), Together AI, Fireworks AI, DeepInfra, Cerebras, Replicate, Fal.ai, Chutes, Cohere и LMSYS Arena.",
    "counts": {
      "domain": 0,
      "domain_suffix": 31,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/openrouter.trs",
      "srs": "release/sing-box/openrouter.srs",
      "json": "release/json/openrouter.json",
      "domains": "release/domains/openrouter.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-poe.srs"
  },
  {
    "id": "cursor",
    "group": "ai",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Cursor, OpenCode, Windsurf и AI-кодинг — ИИ-редакторы, терминальные агенты и генераторы",
    "description": "[Маршрут: Только в Прокси / VPN — геоблок по IP] Инструменты ИИ-разработки и кодинг-агенты: Cursor (cursor.com, cursorapi.com), OpenCode (opencode.ai, models.dev), Windsurf / Codeium (windsurf.com, codeium.com), JetBrains AI (grazie.ai, jetbrains.ai), Trae, Cline, Roo Code, Kilo Code, Aider, Lovable, Bolt.new, v0.dev, Devin, Replit, CodeRabbit и Context7.",
    "counts": {
      "domain": 0,
      "domain_suffix": 68,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/cursor.trs",
      "srs": "release/sing-box/cursor.srs",
      "json": "release/json/cursor.json",
      "domains": "release/domains/cursor.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-cursor.srs"
  },
  {
    "id": "perplexity",
    "group": "ai",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Perplexity AI — поисковая нейросеть, Deep Research, You.com и Genspark",
    "description": "[Маршрут: Только в Прокси / VPN — геоблок по IP] Поисковые и исследовательские ИИ-системы: Perplexity (perplexity.ai, pplx.ai), You.com, Genspark, Consensus, Elicit и Scite.",
    "counts": {
      "domain": 0,
      "domain_suffix": 11,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/perplexity.trs",
      "srs": "release/sing-box/perplexity.srs",
      "json": "release/json/perplexity.json",
      "domains": "release/domains/perplexity.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-perplexity.srs"
  },
  {
    "id": "copilot",
    "group": "ai",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Microsoft & GitHub Copilot — GitHub Copilot, Copilot Chat, Workspace и Designer",
    "description": "[Маршрут: Только в Прокси / VPN — геоблок по IP] Все домены автодополнения кода GitHub Copilot (githubcopilot.com, copilot-proxy.githubusercontent.com) и ассистента Microsoft Copilot в Windows, Edge и Office 365 (copilot.microsoft.com, sydney.bing.com).",
    "counts": {
      "domain": 2,
      "domain_suffix": 12,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/copilot.trs",
      "srs": "release/sing-box/copilot.srs",
      "json": "release/json/copilot.json",
      "domains": "release/domains/copilot.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-github-copilot.srs"
  },
  {
    "id": "deepseek",
    "group": "ai",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "DeepSeek, Kimi, Qwen и Manus — нейросети DeepSeek-R1/V3, Kimi, Qwen Chat и Manus",
    "description": "[Маршрут: В Прокси / VPN] Домены DeepSeek (deepseek.com, chat.deepseek.com, api.deepseek.com), Moonshot Kimi (kimi.ai), Alibaba Qwen Chat (chat.qwen.ai), MiniMax, Z.ai, Manus (manus.im) и Dify.",
    "counts": {
      "domain": 0,
      "domain_suffix": 12,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/deepseek.trs",
      "srs": "release/sing-box/deepseek.srs",
      "json": "release/json/deepseek.json",
      "domains": "release/domains/deepseek.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-deepseek.srs"
  },
  {
    "id": "midjourney",
    "group": "ai",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Midjourney, Flux и Civitai — генерация изображений, LoRA-модели, Leonardo, Krea и 3D",
    "description": "[Маршрут: Только в Прокси / VPN — геоблок по IP] Платформы генерации графики, дизайна и 3D: Midjourney (midjourney.com), Civitai (civitai.com), Black Forest Labs / Flux (bfl.ai), Leonardo.ai, Ideogram, Krea, Recraft, Magnific, Stability AI, ComfyUI Registry, OpenArt, Tripo3D и Meshy.",
    "counts": {
      "domain": 0,
      "domain_suffix": 42,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/midjourney.trs",
      "srs": "release/sing-box/midjourney.srs",
      "json": "release/json/midjourney.json",
      "domains": "release/domains/midjourney.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-comfy.srs"
  },
  {
    "id": "elevenlabs",
    "group": "ai",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "ElevenLabs, Suno, Udio и Runway — синтез речи, генерация музыки и ИИ-видео",
    "description": "[Маршрут: Только в Прокси / VPN — геоблок по IP] Сервисы генерации звука, клонирования голоса, музыки и видео: ElevenLabs (elevenlabs.io), Suno (suno.com), Udio (udio.com), Runway (runwayml.com), Kling AI (klingai.com), Luma Dream Machine, Pika, Hailuo Video, HeyGen, Synthesia, Vidu и PixVerse.",
    "counts": {
      "domain": 0,
      "domain_suffix": 46,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/elevenlabs.trs",
      "srs": "release/sing-box/elevenlabs.srs",
      "json": "release/json/elevenlabs.json",
      "domains": "release/domains/elevenlabs.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-elevenlabs.srs"
  },
  {
    "id": "huggingface",
    "group": "ai",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Hugging Face, Ollama и Character.AI — открытые LLM-модели, локальный запуск и ролевые чаты",
    "description": "[Маршрут: В Прокси / VPN] Репозитории моделей и датасетов Hugging Face (huggingface.co, hf.co), каталоги локальных LLM (ollama.com, lmstudio.ai, openwebui.com), а также платформы ролевых ИИ-персонажей (Character.AI, JanitorAI, Chub, NovelAI) и ML-инфраструктура (Weights & Biases, Kaggle, LangChain).",
    "counts": {
      "domain": 0,
      "domain_suffix": 49,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/huggingface.trs",
      "srs": "release/sing-box/huggingface.srs",
      "json": "release/json/huggingface.json",
      "domains": "release/domains/huggingface.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-huggingface.srs"
  },
  {
    "id": "ai_video",
    "group": "ai",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Генерация ИИ-видео и аватаров — Kling AI, Hailuo (MiniMax), Luma, Pika, HeyGen и Vidu",
    "description": "[Маршрут: Только в Прокси / VPN — геоблок по IP] Ведущие нейросети генерации видео, анимации, говорящих аватаров и VFX: Kling AI (klingai.com), Hailuo AI / MiniMax (hailuoai.video), Luma Dream Machine (lumalabs.ai), Pika Art (pika.art), HeyGen (heygen.com), Synthesia, Vidu, PixVerse, Higgsfield AI, Hedra, Topaz Labs и Magnific AI.",
    "counts": {
      "domain": 0,
      "domain_suffix": 37,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/ai_video.trs",
      "srs": "release/sing-box/ai_video.srs",
      "json": "release/json/ai_video.json",
      "domains": "release/domains/ai_video.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/Dushnilin/tachyon-lists/releases/latest/download/ai_video.srs"
  },
  {
    "id": "ai_cloud_gpu",
    "group": "ai",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Облачные GPU и ИИ-инференс — RunPod, Vast.ai, Replicate, Fal.ai, Together AI и Modal",
    "description": "[Маршрут: В Прокси / VPN] Платформы почасовой аренды GPU (A100/H100/RTX 4090) под Stable Diffusion / Flux / LLM и бессерверного API-инференса: RunPod (runpod.io), Vast.ai (vast.ai), Replicate (replicate.com), Fal.ai (fal.ai, fal.run), Together AI, Fireworks AI, Modal, Lambda Labs, Baseten, DeepInfra и Chutes AI.",
    "counts": {
      "domain": 0,
      "domain_suffix": 34,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/ai_cloud_gpu.trs",
      "srs": "release/sing-box/ai_cloud_gpu.srs",
      "json": "release/json/ai_cloud_gpu.json",
      "domains": "release/domains/ai_cloud_gpu.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/Dushnilin/tachyon-lists/releases/latest/download/ai_cloud_gpu.srs"
  },
  {
    "id": "youtube",
    "group": "media",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "YouTube — видеосервис, YouTube Music, Studio и кэш-серверы (googlevideo / ytimg)",
    "description": "[Маршрут: В Desync / Zapret или Прокси / VPN] Полный набор доменов YouTube: youtube.com, youtu.be, googlevideo.com (видеопотоки GGC), ytimg.com (превью), ggpht.com (аватарки каналов), youtubei.googleapis.com и YouTube Music.",
    "counts": {
      "domain": 0,
      "domain_suffix": 182,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/youtube.trs",
      "srs": "release/sing-box/youtube.srs",
      "json": "release/json/youtube.json",
      "domains": "release/domains/youtube.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/youtube.srs"
  },
  {
    "id": "twitch",
    "group": "media",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Twitch — стриминговая платформа, видеопотоки (ttvnw.net) и чат",
    "description": "[Маршрут: В Прокси / VPN или Desync] Все домены платформы Twitch (twitch.tv, ttvnw.net, jtvnw.net, live-video.net). Для снятия лимита 720p и отключения рекламы без проксирования самого видеопотока используйте список «Twitch (без рекламы и 1080p+)».",
    "counts": {
      "domain": 2,
      "domain_suffix": 41,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/twitch.trs",
      "srs": "release/sing-box/twitch.srs",
      "json": "release/json/twitch.json",
      "domains": "release/domains/twitch.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/twitch.srs"
  },
  {
    "id": "twitch_ads",
    "group": "media",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Twitch (без рекламы и 1080p+) — серверы манифестов качества видео и рекламы",
    "description": "[Маршрут: Только в Прокси / VPN] Узкий список серверов выбора качества потока и рекламных вставок Twitch (usher.ttvnw.net, gql.twitch.tv, edge.ads.twitch.tv). Направьте его в Прокси (оставив остальной Twitch напрямую): видеопоток пойдёт напрямую без нагрузки на VPN, но пропадёт реклама и вернётся качество 1080p60 / 1440p.",
    "counts": {
      "domain": 0,
      "domain_suffix": 5,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/twitch_ads.trs",
      "srs": "release/sing-box/twitch_ads.srs",
      "json": "release/json/twitch_ads.json",
      "domains": "release/domains/twitch_ads.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/hydraponique/roscomvpn-geosite/master/release/sing-box/twitch-ads.srs"
  },
  {
    "id": "spotify",
    "group": "media",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Spotify — музыкальный стриминг, аудио-CDN и клиентские API",
    "description": "[Маршрут: Только в Прокси / VPN — геоблок по IP] Все домены Spotify: spotify.com, scdn.co, spotifycdn.com, audio-ak-spotify-com.akamaized.net, psavn.com и серверы авторизации приложений.",
    "counts": {
      "domain": 7,
      "domain_suffix": 18,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/spotify.trs",
      "srs": "release/sing-box/spotify.srs",
      "json": "release/json/spotify.json",
      "domains": "release/domains/spotify.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-spotify.srs"
  },
  {
    "id": "netflix",
    "group": "media",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Netflix — онлайн-кинотеатр, видеопотоки (nflxvideo.net) и статика",
    "description": "[Маршрут: Только в Прокси / VPN — геоблок по IP] Домены видеосервиса Netflix: netflix.com, nflxvideo.net, nflximg.net, nflxso.net, nflxext.com и проверка скорости fast.com.",
    "counts": {
      "domain": 0,
      "domain_suffix": 24,
      "domain_keyword": 0,
      "domain_regex": 4,
      "ipv4_cidr": 36,
      "ipv6_cidr": 86
    },
    "files": {
      "trs": "release/tachyon/netflix.trs",
      "srs": "release/sing-box/netflix.srs",
      "json": "release/json/netflix.json",
      "domains": "release/domains/netflix.lst",
      "subnets": "release/subnets/netflix.lst"
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-netflix.srs"
  },
  {
    "id": "tiktok",
    "group": "media",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "TikTok — приложение, веб-версия и медиа-CDN ByteDance",
    "description": "[Маршрут: Только в Прокси / VPN — региональный блок РФ] Домены TikTok и ByteDance (tiktok.com, tiktokv.com, tiktokcdn.com, byteoversea.com, musical.ly) для просмотра новых видео и стримов без региональных ограничений в РФ.",
    "counts": {
      "domain": 5,
      "domain_suffix": 48,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/tiktok.trs",
      "srs": "release/sing-box/tiktok.srs",
      "json": "release/json/tiktok.json",
      "domains": "release/domains/tiktok.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/tiktok.srs"
  },
  {
    "id": "hdrezka",
    "group": "media",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "HDRezka — онлайн-кинотеатр, видео-балансеры (Voidboost) и актуальные зеркала",
    "description": "[Маршрут: В Прокси / VPN или Desync] Домены, зеркала и CDN видеопотоков онлайн-кинотеатра HDRezka (rezka.ag, hdrezka.ag, voidboost.cc, stream.voidboost.cc и связанные балансеры).",
    "counts": {
      "domain": 0,
      "domain_suffix": 17,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/hdrezka.trs",
      "srs": "release/sing-box/hdrezka.srs",
      "json": "release/json/hdrezka.json",
      "domains": "release/domains/hdrezka.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/hdrezka.srs"
  },
  {
    "id": "anime",
    "group": "media",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Аниме — Shikimori, AnimeGO, Jut.su, Kodik, Anilibria, Crunchyroll",
    "description": "[Маршрут: В Прокси / VPN или Desync] Популярные аниме-порталы, базы данных и видеоплееры: Shikimori, AnimeGO, Jut.su, YummyAnime, Anilibria, Kodik, Sibnet, Crunchyroll и MyAnimeList.",
    "counts": {
      "domain": 0,
      "domain_suffix": 42,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/anime.trs",
      "srs": "release/sing-box/anime.srs",
      "json": "release/json/anime.json",
      "domains": "release/domains/anime.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/anime.srs"
  },
  {
    "id": "pinterest",
    "group": "media",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Pinterest — фотохостинг, пины и серверы изображений (pinimg.com)",
    "description": "[Маршрут: В Прокси / VPN или Desync] Домены визуальной соцсети Pinterest: pinterest.com, pin.it и CDN картинок i.pinimg.com / s.pinimg.com (обеспечивает стабильную загрузку медиаконтента).",
    "counts": {
      "domain": 0,
      "domain_suffix": 52,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/pinterest.trs",
      "srs": "release/sing-box/pinterest.srs",
      "json": "release/json/pinterest.json",
      "domains": "release/domains/pinterest.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/hydraponique/roscomvpn-geosite/master/release/sing-box/pinterest.srs"
  },
  {
    "id": "soundcloud_music",
    "group": "media",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "SoundCloud, Deezer, Tidal и Genius — музыкальные стриминги, тексты песен и Hi-Fi аудио",
    "description": "[Маршрут: В Прокси / VPN] Музыкальные сервисы и энциклопедии с региональными ограничениями или геоблоком: SoundCloud (soundcloud.com, sndcdn.com), Deezer (deezer.com, dzcdn.net), Tidal (tidal.com), Qobuz, Bandcamp, Genius (genius.com), Last.fm, Mixcloud, TuneIn и Discogs.",
    "counts": {
      "domain": 0,
      "domain_suffix": 30,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/soundcloud_music.trs",
      "srs": "release/sing-box/soundcloud_music.srs",
      "json": "release/json/soundcloud_music.json",
      "domains": "release/domains/soundcloud_music.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-soundcloud.srs"
  },
  {
    "id": "rutracker_lampa",
    "group": "media",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "RuTracker, Lampa, KinoPub и Flibusta — трекеры, онлайн-кинотеатры для ТВ и библиотеки",
    "description": "[Маршрут: В Прокси / VPN или Desync] Народный набор для дома и Android TV: зеркала RuTracker, Rutor, NNM-Club, Kinozal, LostFilm, KinoPub, балансеры и плагины Lampa (Filmix, Cub, BWA, Zetflix), а также книжные и научные библиотеки (Flibusta, Coollib, Z-Library, Anna's Archive, LibGen, Sci-Hub).",
    "counts": {
      "domain": 0,
      "domain_suffix": 123,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/rutracker_lampa.trs",
      "srs": "release/sing-box/rutracker_lampa.srs",
      "json": "release/json/rutracker_lampa.json",
      "domains": "release/domains/rutracker_lampa.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-rutracker.srs"
  },
  {
    "id": "patreon_creators",
    "group": "media",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Patreon, Medium, Substack, DeviantArt и Pixiv — платформы авторов, блогов и иллюстраторов",
    "description": "[Маршрут: В Прокси / VPN] Платформы поддержки авторов, блогов и цифрового арта с региональными ограничениями или геоблоком: Patreon (patreon.com), Medium (medium.com), Substack, DeviantArt, ArtStation, Pixiv (pixiv.net, pximg.net), Gumroad, Ko-fi, AO3, Ficbook, Goodreads и Letterboxd.",
    "counts": {
      "domain": 1,
      "domain_suffix": 49,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/patreon_creators.trs",
      "srs": "release/sing-box/patreon_creators.srs",
      "json": "release/json/patreon_creators.json",
      "domains": "release/domains/patreon_creators.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-patreon.srs"
  },
  {
    "id": "youtube_images",
    "group": "media",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "YouTube (только превью, аватарки и интерфейс — без видеопотока googlevideo)",
    "description": "[Маршрут: В Прокси / VPN — при раздельной маршрутизации видеопотока] Серверы обложек роликов (i.ytimg.com, i9.ytimg.com), аватарок каналов (yt3.ggpht.com, yt4.ggpht.com) и веб-интерфейса YouTube без тяжёлых видеосерверов googlevideo.com. Позволяет направить загрузку статики и миниатюр через отдельный прокси-туннель.",
    "counts": {
      "domain": 0,
      "domain_suffix": 11,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/youtube_images.trs",
      "srs": "release/sing-box/youtube_images.srs",
      "json": "release/json/youtube_images.json",
      "domains": "release/domains/youtube_images.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/Dushnilin/tachyon-lists/releases/latest/download/youtube_images.srs"
  },
  {
    "id": "tmdb_metadata",
    "group": "media",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Постеры и базы фильмов для Lampa, Plex, Kodi и Jellyfin — TMDB, TheTVDB, IMDb и Last.fm",
    "description": "[Маршрут: В Прокси / VPN или Desync] Базы метаданных, обложек, актёров и описаний фильмов и музыки: The Movie Database (themoviedb.org, image.tmdb.org, api.themoviedb.org — для загрузки постеров в Lampa, Plex, Kodi, Jellyfin и Infuse), TheTVDB, IMDb, Trakt.tv, Fanart.tv, OpenSubtitles, Last.fm, MusicBrainz и Discogs.",
    "counts": {
      "domain": 4,
      "domain_suffix": 39,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/tmdb_metadata.trs",
      "srs": "release/sing-box/tmdb_metadata.srs",
      "json": "release/json/tmdb_metadata.json",
      "domains": "release/domains/tmdb_metadata.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/tmdb.srs"
  },
  {
    "id": "streaming_west",
    "group": "media",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Зарубежные онлайн-кинотеатры — Disney+, Max (HBO), Amazon Prime Video, Hulu, Paramount+ и Plex",
    "description": "[Маршрут: Только в Прокси / VPN — геоблок по IP] Западные стриминговые сервисы и медиасерверы: Disney+ (disneyplus.com, bamgrid.com), Max / HBO (max.com, hbomax.com), Amazon Prime Video (primevideo.com, aiv-cdn.net), Hulu, Paramount+, Peacock, MUBI и облако домашнего медиасервера Plex (plex.tv, plex.direct).",
    "counts": {
      "domain": 14,
      "domain_suffix": 321,
      "domain_keyword": 0,
      "domain_regex": 1,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/streaming_west.trs",
      "srs": "release/sing-box/streaming_west.srs",
      "json": "release/json/streaming_west.json",
      "domains": "release/domains/streaming_west.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/disney.srs"
  },
  {
    "id": "books_archives",
    "group": "media",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Архивы интернета и научные библиотеки — Wayback Machine, Sci-Hub, LibGen, Anna's Archive и Z-Library",
    "description": "[Маршрут: В Прокси / VPN или Desync] Архив интернета (archive.org / Wayback Machine), архивы веб-страниц (archive.is, archive.ph, ghostarchive.org), крупнейшие библиотеки книг и научных статей: Anna's Archive, Z-Library (z-lib.gs, singlelogin.re), Library Genesis (libgen.is), Sci-Hub, Project Gutenberg, ResearchGate, Academia.edu и AO3 (archiveofourown.org).",
    "counts": {
      "domain": 0,
      "domain_suffix": 121,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/books_archives.trs",
      "srs": "release/sing-box/books_archives.srs",
      "json": "release/json/books_archives.json",
      "domains": "release/domains/books_archives.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/archive.srs"
  },
  {
    "id": "podcasts_radio",
    "group": "media",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Подкасты, онлайн-радио и аудиокниги — хостинги Apple/Spotify подкастов, TuneIn, DI.FM и Audible",
    "description": "[Маршрут: В Прокси / VPN] Зарубежные CDN-хостинги подкастов (megaphone.fm, art19.com, simplecast.com, acast.com, omny.fm, buzzsprout.com, libsyn.com, podbean.com — используются для загрузки выпусков в приложении «Подкасты» на iPhone), плееры Pocket Casts и Overcast, аудиокниги Audible, Storytel, Bookmate и интернет-радио TuneIn Radio, DI.FM и Radio Garden.",
    "counts": {
      "domain": 0,
      "domain_suffix": 57,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/podcasts_radio.trs",
      "srs": "release/sing-box/podcasts_radio.srs",
      "json": "release/json/podcasts_radio.json",
      "domains": "release/domains/podcasts_radio.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/pocketcasts.srs"
  },
  {
    "id": "discord",
    "group": "social",
    "kind": "subnets",
    "recommended_action": "proxy",
    "title": "Discord — мессенджер, чаты, CDN вложений и голосовые шлюзы",
    "description": "[Маршрут: В Прокси / VPN или Desync] Все домены и подсети Discord: discord.com, discord.gg, discordapp.com, discordapp.net, discord.media и голосовые серверы.",
    "counts": {
      "domain": 1,
      "domain_suffix": 28,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 8,
      "ipv6_cidr": 1
    },
    "files": {
      "trs": "release/tachyon/discord.trs",
      "srs": "release/sing-box/discord.srs",
      "json": "release/json/discord.json",
      "domains": "release/domains/discord.lst",
      "subnets": "release/subnets/discord.lst"
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/discord.srs"
  },
  {
    "id": "telegram",
    "group": "social",
    "kind": "mixed",
    "recommended_action": "proxy",
    "title": "Telegram — мессенджер, веб-клиенты, Telegraph и все датацентры (DC1–DC5)",
    "description": "[Маршрут: В Прокси / VPN] Домены (telegram.org, t.me, web.telegram.org, telegra.ph, telesco.pe) и официальные IPv4/IPv6-подсети всех датацентров Telegram для работы звонков, кружочков и быстрой загрузки медиа.",
    "counts": {
      "domain": 0,
      "domain_suffix": 27,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 10,
      "ipv6_cidr": 4
    },
    "files": {
      "trs": "release/tachyon/telegram.trs",
      "srs": "release/sing-box/telegram.srs",
      "json": "release/json/telegram.json",
      "domains": "release/domains/telegram.lst",
      "subnets": "release/subnets/telegram.lst"
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/telegram.srs"
  },
  {
    "id": "meta",
    "group": "social",
    "kind": "mixed",
    "recommended_action": "proxy",
    "title": "Meta — Instagram, Facebook, Threads, Messenger и медиа-серверы (fbcdn)",
    "description": "[Маршрут: В Прокси / VPN] Все домены и IP-подсети компании Meta: instagram.com, cdninstagram.com, facebook.com, fbcdn.net, threads.net и messenger.com (без WhatsApp).",
    "counts": {
      "domain": 1,
      "domain_suffix": 554,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 80,
      "ipv6_cidr": 42
    },
    "files": {
      "trs": "release/tachyon/meta.trs",
      "srs": "release/sing-box/meta.srs",
      "json": "release/json/meta.json",
      "domains": "release/domains/meta.lst",
      "subnets": "release/subnets/meta.lst"
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/meta.srs"
  },
  {
    "id": "twitter",
    "group": "social",
    "kind": "mixed",
    "recommended_action": "proxy",
    "title": "X (Twitter) — соцсеть, короткие ссылки t.co и медиа-CDN (twimg.com)",
    "description": "[Маршрут: В Прокси / VPN или Desync] Домены и IP-подсети соцсети X / Twitter: x.com, twitter.com, t.co, twimg.com, abs.twimg.com, pbs.twimg.com и video.twimg.com.",
    "counts": {
      "domain": 0,
      "domain_suffix": 24,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 16,
      "ipv6_cidr": 3
    },
    "files": {
      "trs": "release/tachyon/twitter.trs",
      "srs": "release/sing-box/twitter.srs",
      "json": "release/json/twitter.json",
      "domains": "release/domains/twitter.lst",
      "subnets": "release/subnets/twitter.lst"
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/twitter.srs"
  },
  {
    "id": "whatsapp",
    "group": "social",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "WhatsApp — мессенджер, аудио/видеозвонки, веб-клиент и медиа-серверы (отдельно от Meta)",
    "description": "[Маршрут: В Прокси / VPN или Direct] Все домены WhatsApp (whatsapp.com, whatsapp.net, wa.me) отдельно от Instagram и Facebook: позволяет точечно маршрутизировать звонки и сообщения WhatsApp без проксирования тяжёлого видео-трафика Instagram.",
    "counts": {
      "domain": 0,
      "domain_suffix": 12,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/whatsapp.trs",
      "srs": "release/sing-box/whatsapp.srs",
      "json": "release/json/whatsapp.json",
      "domains": "release/domains/whatsapp.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-whatsapp.srs"
  },
  {
    "id": "messengers",
    "group": "social",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Signal, Viber, TeamSpeak и Matrix — мессенджеры и голосовые чаты",
    "description": "[Маршрут: В Прокси / VPN] Альтернативные мессенджеры и голосовые серверы для командной связи: Signal (signal.org, whispersystems.org), Viber (viber.com), TeamSpeak 3/5 (teamspeak.com, myteamspeak.com), Guilded, Element / Matrix, Threema, Session, SimpleX и Wire.",
    "counts": {
      "domain": 0,
      "domain_suffix": 29,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/messengers.trs",
      "srs": "release/sing-box/messengers.srs",
      "json": "release/json/messengers.json",
      "domains": "release/domains/messengers.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-signal.srs"
  },
  {
    "id": "reddit",
    "group": "social",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Reddit — форум, приложение, видеоплеер (v.redd.it) и изображения (i.redd.it)",
    "description": "[Маршрут: В Прокси / VPN или Desync] Все домены и медиа-CDN платформы Reddit: reddit.com, redd.it, v.redd.it, i.redd.it, redditmedia.com и redditstatic.com (устраняет зависание видео и картинок).",
    "counts": {
      "domain": 0,
      "domain_suffix": 12,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/reddit.trs",
      "srs": "release/sing-box/reddit.srs",
      "json": "release/json/reddit.json",
      "domains": "release/domains/reddit.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-reddit.srs"
  },
  {
    "id": "zoom_teams",
    "group": "social",
    "kind": "mixed",
    "recommended_action": "proxy",
    "title": "Zoom, Google Meet, MS Teams, Webex и Slack — рабочие видеоконференции и корпоративные чаты",
    "description": "[Маршрут: Напрямую (Direct) для минимальной задержки или в Прокси при корпоративном геоблоке] Платформы удалённой работы и видеозвонков: Zoom (zoom.us), Google Meet (meet.google.com + STUN/TURN подсети), Microsoft Teams, Cisco Webex, Slack (slack.com), Loom, Gather, Whereby и Jitsi.",
    "counts": {
      "domain": 0,
      "domain_suffix": 37,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 3,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/zoom_teams.trs",
      "srs": "release/sing-box/zoom_teams.srs",
      "json": "release/json/zoom_teams.json",
      "domains": "release/domains/zoom_teams.lst",
      "subnets": "release/subnets/zoom_teams.lst"
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-zoom.srs"
  },
  {
    "id": "linkedin",
    "group": "social",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "LinkedIn, Glassdoor и Indeed — деловая соцсеть и международный поиск работы в IT",
    "description": "[Маршрут: В Прокси / VPN] Профессиональная соцсеть LinkedIn (linkedin.com, licdn.com, lnkd.in, slideshare.net), а также международные карьерные порталы Glassdoor, Indeed, Wellfound (AngelList) и Levels.fyi.",
    "counts": {
      "domain": 3,
      "domain_suffix": 19,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/linkedin.trs",
      "srs": "release/sing-box/linkedin.srs",
      "json": "release/json/linkedin.json",
      "domains": "release/domains/linkedin.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-linkedin.srs"
  },
  {
    "id": "discord_voice",
    "group": "social",
    "kind": "mixed",
    "recommended_action": "proxy",
    "title": "Discord Voice — только голосовые серверы и звонки WebRTC / UDP (отдельно от чата)",
    "description": "[Маршрут: В низкопинговый игровой Прокси / VPN с поддержкой UDP или Desync] Узкий список голосовых и видео-шлюзов Discord (*.discord.media и UDP-подсети голосовых серверов Discord). Позволяет направить голосовые каналы и стриминг экрана через самый быстрый узел с минимальным пингом отдельно от основного чата и картинок Discord.",
    "counts": {
      "domain": 0,
      "domain_suffix": 1,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 8,
      "ipv6_cidr": 1
    },
    "files": {
      "trs": "release/tachyon/discord_voice.trs",
      "srs": "release/sing-box/discord_voice.srs",
      "json": "release/json/discord_voice.json",
      "domains": "release/domains/discord_voice.lst",
      "subnets": "release/subnets/discord_voice.lst"
    },
    "fallback_srs": "https://github.com/Dushnilin/tachyon-lists/releases/latest/download/discord_voice.srs"
  },
  {
    "id": "games_all",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Игры и игровые платформы (все) — Steam, Epic, Ubisoft, War Thunder, Battle.net, EA, Riot, Xbox, PSN",
    "description": "[Маршрут: В Прокси / VPN или Direct] Единый сводный список всех популярных игровых лаунчеров, магазинов, античитов (BattlEye, EasyAntiCheat) и серверов: Steam, Epic Games, Ubisoft Connect, War Thunder / Gaijin, Battle.net / Blizzard, EA App / Origin, Riot Games, Xbox Live, PlayStation Network, Nintendo, GOG, Wargaming, HoYoverse, Minecraft, Rockstar, Roblox, Supercell, Escape from Tarkov, FACEIT и PUBG.",
    "counts": {
      "domain": 54,
      "domain_suffix": 1301,
      "domain_keyword": 0,
      "domain_regex": 3,
      "ipv4_cidr": 114,
      "ipv6_cidr": 22
    },
    "files": {
      "trs": "release/tachyon/games_all.trs",
      "srs": "release/sing-box/games_all.srs",
      "json": "release/json/games_all.json",
      "domains": "release/domains/games_all.lst",
      "subnets": "release/subnets/games_all.lst"
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-category-games-!cn.srs"
  },
  {
    "id": "steam",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Steam — магазин, сообщество, инвентарь, чат и CDN загрузок Valve",
    "description": "[Маршрут: Напрямую (Direct) или в Прокси для смены региона магазина] Все домены экосистемы Valve и Steam: store.steampowered.com, steamcommunity.com, steamstatic.com, steamusercontent.com, steamcontent.com и steamserver.net.",
    "counts": {
      "domain": 13,
      "domain_suffix": 47,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/steam.trs",
      "srs": "release/sing-box/steam.srs",
      "json": "release/json/steam.json",
      "domains": "release/domains/steam.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/hydraponique/roscomvpn-geosite/master/release/sing-box/steam.srs"
  },
  {
    "id": "epicgames",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Epic Games — EGS, Fortnite, Unreal Engine, Rocket League и EasyAntiCheat",
    "description": "[Маршрут: В Прокси / VPN (для раздач/покупок) или Direct] Домены Epic Games Store, Fortnite, Rocket League, Fall Guys, движка Unreal Engine, Fab/Quixel и античита EasyAntiCheat (epicgames.com, unrealengine.com, fortnite.com, easy.ac).",
    "counts": {
      "domain": 0,
      "domain_suffix": 34,
      "domain_keyword": 0,
      "domain_regex": 3,
      "ipv4_cidr": 13,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/epicgames.trs",
      "srs": "release/sing-box/epicgames.srs",
      "json": "release/json/epicgames.json",
      "domains": "release/domains/epicgames.lst",
      "subnets": "release/subnets/epicgames.lst"
    },
    "fallback_srs": "https://raw.githubusercontent.com/hydraponique/roscomvpn-geosite/master/release/sing-box/epicgames.srs"
  },
  {
    "id": "ubisoft",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Ubisoft Connect (Uplay) — Rainbow Six Siege, Assassin's Creed, Far Cry, The Division и For Honor",
    "description": "[Маршрут: В Прокси / VPN] Домены лаунчера Ubisoft Connect (Uplay), серверов авторизации, облачных сохранений, CDN обновлений и античитов (ubisoft.com, ubi.com, ubisoftconnect.com, uplay.com, rainbowsix.com, ubistatic-a.akamaihd.net, battleye.com).",
    "counts": {
      "domain": 1,
      "domain_suffix": 57,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/ubisoft.trs",
      "srs": "release/sing-box/ubisoft.srs",
      "json": "release/json/ubisoft.json",
      "domains": "release/domains/ubisoft.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-ubisoft.srs"
  },
  {
    "id": "warthunder",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "War Thunder и Gaijin — War Thunder, Enlisted, Crossout, CRSED, Star Conflict и Gaijin.Net",
    "description": "[Маршрут: В Прокси / VPN или Direct] Домены игр и лаунчера Gaijin Entertainment: War Thunder (warthunder.com, wtmobile.com), Enlisted (enlisted.net), Crossout (crossout.net), CRSED, Star Conflict, Modern Warships, магазин Gaijin.Net и мастер-серверы обновлений.",
    "counts": {
      "domain": 0,
      "domain_suffix": 16,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/warthunder.trs",
      "srs": "release/sing-box/warthunder.srs",
      "json": "release/json/warthunder.json",
      "domains": "release/domains/warthunder.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-gaijin.srs"
  },
  {
    "id": "blizzard",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Battle.net (Activision Blizzard) — World of Warcraft, Overwatch 2, Diablo IV, Call of Duty и Hearthstone",
    "description": "[Маршрут: В Прокси / VPN] Домены лаунчера Battle.net, магазина и серверов Activision Blizzard: battle.net, blizzard.com, activision.com, callofduty.com, worldofwarcraft.com, playoverwatch.com, diablo4.com, playhearthstone.com и CDN загрузок.",
    "counts": {
      "domain": 2,
      "domain_suffix": 68,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/blizzard.trs",
      "srs": "release/sing-box/blizzard.srs",
      "json": "release/json/blizzard.json",
      "domains": "release/domains/blizzard.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-blizzard.srs"
  },
  {
    "id": "callofduty",
    "group": "gaming",
    "kind": "mixed",
    "recommended_action": "proxy",
    "title": "Call of Duty и Demonware — Warzone, Black Ops 6, Modern Warfare II/III, CoD HQ и микропатчи",
    "description": "[Маршрут: В Прокси / VPN (устраняет ошибки HUENEME-NEGEV / TRAVIS-RILEA и вечный цикл «Обновление завершено. Требуется перезапуск»)] Полный список доменов и 805 IP-подсетей матчей Call of Duty для Steam, Battle.net, Xbox Game Pass и PlayStation: шлюзы матчмейкинга и лобби Demonware (demonware.net + AS60229), CDN микропатчей и шейдеров Beenox (d2cyf1jgpkmugk.cloudfront.net, fastdl/content.callofduty.com, cod-live-updates.activision.com, blzstatic.com) и игровые серверы Warzone.",
    "counts": {
      "domain": 0,
      "domain_suffix": 77,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 797,
      "ipv6_cidr": 8
    },
    "files": {
      "trs": "release/tachyon/callofduty.trs",
      "srs": "release/sing-box/callofduty.srs",
      "json": "release/json/callofduty.json",
      "domains": "release/domains/callofduty.lst",
      "subnets": "release/subnets/callofduty.lst"
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/activision-blizzard.srs"
  },
  {
    "id": "riot",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Riot Games — Valorant, League of Legends, TFT, Riot Client и Vanguard",
    "description": "[Маршрут: В Прокси / VPN или Direct] Сервисы авторизации, обновлений и матчей Riot Games: riotgames.com, leagueoflegends.com, playvalorant.com, pvp.net и riotcdn.net.",
    "counts": {
      "domain": 0,
      "domain_suffix": 54,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/riot.trs",
      "srs": "release/sing-box/riot.srs",
      "json": "release/json/riot.json",
      "domains": "release/domains/riot.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/hydraponique/roscomvpn-geosite/master/release/sing-box/riot.srs"
  },
  {
    "id": "origin",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "EA / Origin — EA App, Apex Legends, Battlefield, EA Sports FC и The Sims",
    "description": "[Маршрут: В Прокси / VPN] Домены Electronic Arts: ea.com, origin.com, tnt-ea.com, apexlegends.com и серверы авторизации, античита и загрузки игр EA App.",
    "counts": {
      "domain": 2,
      "domain_suffix": 169,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 13,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/origin.trs",
      "srs": "release/sing-box/origin.srs",
      "json": "release/json/origin.json",
      "domains": "release/domains/origin.lst",
      "subnets": "release/subnets/origin.lst"
    },
    "fallback_srs": "https://raw.githubusercontent.com/hydraponique/roscomvpn-geosite/master/release/sing-box/origin.srs"
  },
  {
    "id": "xbox",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Xbox Live и Game Pass — консоли Xbox, PC Game Pass, Cloud Gaming, Forza, Halo и Bethesda",
    "description": "[Маршрут: В Прокси / VPN] Экосистема Xbox и игровых студий Microsoft / Bethesda: xbox.com, xboxlive.com, gamepass.com, xboxservices.com, forzamotorsport.net, halowaypoint.com, seaofthieves.com, flightsimulator.com, bethesda.net, doom.com и elderscrolls.com.",
    "counts": {
      "domain": 5,
      "domain_suffix": 63,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/xbox.trs",
      "srs": "release/sing-box/xbox.srs",
      "json": "release/json/xbox.json",
      "domains": "release/domains/xbox.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-xbox.srs"
  },
  {
    "id": "playstation",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "PlayStation Network (PSN) — PS5/PS4, PS Store, PS Plus, тусовки и обновления игр",
    "description": "[Маршрут: В Прокси / VPN] Сетевые сервисы Sony PlayStation: playstation.com, playstation.net, playstationnetwork.com, sonyentertainmentnetwork.com, CDN загрузок dl.playstation.net, а также Bungie / Helldivers 2.",
    "counts": {
      "domain": 0,
      "domain_suffix": 16,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/playstation.trs",
      "srs": "release/sing-box/playstation.srs",
      "json": "release/json/playstation.json",
      "domains": "release/domains/playstation.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-playstation.srs"
  },
  {
    "id": "nintendo",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Nintendo Switch — Nintendo eShop, Switch Online, аккаунты и обновления игр",
    "description": "[Маршрут: В Прокси / VPN] Все домены консолей Nintendo Switch, магазина eShop, подписки Nintendo Switch Online и игр Pokémon / Zelda / Mario / Splatoon (nintendo.com, nintendo.net, nintendowifi.net, pokemon.com).",
    "counts": {
      "domain": 0,
      "domain_suffix": 131,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/nintendo.trs",
      "srs": "release/sing-box/nintendo.srs",
      "json": "release/json/nintendo.json",
      "domains": "release/domains/nintendo.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-nintendo.srs"
  },
  {
    "id": "gog",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "GOG и CD Projekt RED — лаунчер GOG Galaxy, Cyberpunk 2077, Ведьмак 3 и Gwent",
    "description": "[Маршрут: В Прокси / VPN] Домены магазина без DRM GOG.com, клиента GOG Galaxy и студий CD Projekt RED (gog.com, gogalaxy.com, gog-statics.com, cdprojektred.com, cyberpunk.net, thewitcher.com).",
    "counts": {
      "domain": 1,
      "domain_suffix": 13,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/gog.trs",
      "srs": "release/sing-box/gog.srs",
      "json": "release/json/gog.json",
      "domains": "release/domains/gog.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-gog.srs"
  },
  {
    "id": "wargaming",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Wargaming — World of Tanks (EU/Global), World of Warships, WoT Blitz и WGC",
    "description": "[Маршрут: В Прокси / VPN] Европейские и глобальные серверы Wargaming.net, лаунчер Wargaming Game Center, World of Tanks, World of Warships и WoT Blitz (wargaming.net, worldoftanks.eu, worldofwarships.eu, wotblitz.com, wgcdn.co).",
    "counts": {
      "domain": 0,
      "domain_suffix": 16,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/wargaming.trs",
      "srs": "release/sing-box/wargaming.srs",
      "json": "release/json/wargaming.json",
      "domains": "release/domains/wargaming.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-wargaming.srs"
  },
  {
    "id": "hoyoverse",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "HoYoverse и Kuro Games — Genshin Impact, Honkai: Star Rail, Zenless Zone Zero, Wuthering Waves",
    "description": "[Маршрут: В Прокси / VPN или Direct] Домены лаунчера HoYoPlay, HoYoLAB и популярных гача-игр: Genshin Impact, Honkai: Star Rail, Zenless Zone Zero, Honkai Impact 3rd, Wuthering Waves (Kuro Games), Arknights, Azur Lane и NIKKE.",
    "counts": {
      "domain": 0,
      "domain_suffix": 45,
      "domain_keyword": 0,
      "domain_regex": 1,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/hoyoverse.trs",
      "srs": "release/sing-box/hoyoverse.srs",
      "json": "release/json/hoyoverse.json",
      "domains": "release/domains/hoyoverse.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-hoyoverse.srs"
  },
  {
    "id": "minecraft",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Minecraft и моддинг — Mojang, CurseForge, Modrinth, NexusMods, PrismLauncher, Fabric и Forge",
    "description": "[Маршрут: В Прокси / VPN] Официальные серверы авторизации и скинов Minecraft / Mojang (minecraft.net, mojang.com, minecraftservices.com), а также главные платформы модов, плагинов и кастомных лаунчеров: CurseForge (forgecdn.net), Modrinth, NexusMods, PrismLauncher, Lunar/Badlion, Fabric, Forge, NeoForge и PaperMC.",
    "counts": {
      "domain": 0,
      "domain_suffix": 45,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/minecraft.trs",
      "srs": "release/sing-box/minecraft.srs",
      "json": "release/json/minecraft.json",
      "domains": "release/domains/minecraft.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-mojang.srs"
  },
  {
    "id": "rockstar",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Rockstar Games и 2K (Take-Two) — GTA V / Online, Red Dead Redemption 2, Social Club, FiveM и 2K",
    "description": "[Маршрут: В Прокси / VPN] Домены Rockstar Games Launcher, Social Club, GTA Online, Red Dead Online, серверов ролевых проектов FiveM / RedM (cfx.re), а также 2K Games (Civilization, NBA 2K, Borderlands, Mafia).",
    "counts": {
      "domain": 0,
      "domain_suffix": 24,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/rockstar.trs",
      "srs": "release/sing-box/rockstar.srs",
      "json": "release/json/rockstar.json",
      "domains": "release/domains/rockstar.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-rockstar.srs"
  },
  {
    "id": "pubg",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "PUBG, THE FINALS, DayZ, VRChat, PoE, Warframe и античиты (BattlEye / EasyAntiCheat)",
    "description": "[Маршрут: В Прокси / VPN] Популярные сетевые игры и античит-системы: PUBG / Krafton, THE FINALS и ARC Raiders (Embark), DayZ и Arma (Bohemia), VRChat, Dead by Daylight, Path of Exile, Warframe, Guild Wars 2, Albion Online, Rust, Squad, Warner Bros. Games (Mortal Kombat), osu! и античиты BattlEye / EasyAntiCheat.",
    "counts": {
      "domain": 2,
      "domain_suffix": 82,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 20,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/pubg.trs",
      "srs": "release/sing-box/pubg.srs",
      "json": "release/json/pubg.json",
      "domains": "release/domains/pubg.lst",
      "subnets": "release/subnets/pubg.lst"
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-pubg.srs"
  },
  {
    "id": "roblox",
    "group": "gaming",
    "kind": "mixed",
    "recommended_action": "proxy",
    "title": "Roblox — игровая платформа, лаунчер, Roblox Studio и игровые серверы",
    "description": "[Маршрут: В Прокси / VPN или Desync] Все домены и игровые IP-подсети Roblox: roblox.com, rbxcdn.com, rbx.com, robloxlabs.com и голосовой чат.",
    "counts": {
      "domain": 7,
      "domain_suffix": 45,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 2,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/roblox.trs",
      "srs": "release/sing-box/roblox.srs",
      "json": "release/json/roblox.json",
      "domains": "release/domains/roblox.lst",
      "subnets": "release/subnets/roblox.lst"
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/roblox.srs"
  },
  {
    "id": "supercell",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Supercell — Brawl Stars, Clash Royale, Clash of Clans, Squad Busters",
    "description": "[Маршрут: Только в Прокси / VPN — геоблок по IP] Игровые серверы, домены авторизации Supercell ID и CDN обновлений для всех мобильных игр Supercell (блокируют вход с российских и белорусских IP).",
    "counts": {
      "domain": 1,
      "domain_suffix": 23,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/supercell.trs",
      "srs": "release/sing-box/supercell.srs",
      "json": "release/json/supercell.json",
      "domains": "release/domains/supercell.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/ushan0v/sing-box-supercell-ruleset/main/supercell.srs"
  },
  {
    "id": "escapefromtarkov",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Escape from Tarkov — лаунчер, сайт, API профилей и серверы Battlestate Games",
    "description": "[Маршрут: В Прокси / VPN или Direct] Домены игры Escape from Tarkov и EFT: Arena (escapefromtarkov.com, tarkov.com, battlestategames.com и CDN обновлений).",
    "counts": {
      "domain": 0,
      "domain_suffix": 6,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/escapefromtarkov.trs",
      "srs": "release/sing-box/escapefromtarkov.srs",
      "json": "release/json/escapefromtarkov.json",
      "domains": "release/domains/escapefromtarkov.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/hydraponique/roscomvpn-geosite/master/release/sing-box/escapefromtarkov.srs"
  },
  {
    "id": "faceit",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "FACEIT — киберспортивная платформа CS2, античит и матчмейкинг",
    "description": "[Маршрут: В Прокси / VPN или Desync] Домены платформы FACEIT (faceit.com, faceit-cdn.net) для открытия лобби, статистики и работы клиента без бесконечной загрузки.",
    "counts": {
      "domain": 0,
      "domain_suffix": 9,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/faceit.trs",
      "srs": "release/sing-box/faceit.srs",
      "json": "release/json/faceit.json",
      "domains": "release/domains/faceit.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/hydraponique/roscomvpn-geosite/master/release/sing-box/faceit.srs"
  },
  {
    "id": "game_backends",
    "group": "gaming",
    "kind": "mixed",
    "recommended_action": "proxy",
    "title": "Сетевые движки игр и голосовой чат — Photon Engine, Vivox Voice, Azure PlayFab и EOS",
    "description": "[Маршрут: В Прокси / VPN (с UDP) или Desync] Сетевая инфраструктура сотен мультиплеерных игр и внутриигрового голосового чата: войс-движок Vivox (vivox.com, unity3d.com — чинит голосовой чат в Valorant, PUBG, LoL, Fortnite, Overwatch 2, Rainbow Six), облако кооп-игр Photon Engine (photonengine.com, exitgames.com + UDP-подсети — чинит Phasmophobia, R.E.P.O., Content Warning, Lethal Company, VRChat, Among Us), Azure PlayFab (playfabapi.com — Helldivers 2, Sea of Thieves, Minecraft) и Epic Online Services (epicgames.dev).",
    "counts": {
      "domain": 0,
      "domain_suffix": 22,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 4,
      "ipv6_cidr": 1
    },
    "files": {
      "trs": "release/tachyon/game_backends.trs",
      "srs": "release/sing-box/game_backends.srs",
      "json": "release/json/game_backends.json",
      "domains": "release/domains/game_backends.lst",
      "subnets": "release/subnets/game_backends.lst"
    },
    "fallback_srs": "https://github.com/Dushnilin/tachyon-lists/releases/latest/download/game_backends.srs"
  },
  {
    "id": "cs2_dota2",
    "group": "gaming",
    "kind": "mixed",
    "recommended_action": "proxy",
    "title": "Valve Matchmaking — CS2, Dota 2, Deadlock и Team Fortress 2 (серверы матчей и SDR)",
    "description": "[Маршрут: В игровой Прокси с минимальным пингом или Direct] Только соревновательные серверы матчей Valve, релеи Steam Datagram Relay (steamdatagram.com, valve.net и подсети AS32590 Valve Corporation) и игровой координатор (CS2, Dota 2, Deadlock, TF2) — без тяжёлого магазина и скачивания игр Steam.",
    "counts": {
      "domain": 0,
      "domain_suffix": 8,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 20,
      "ipv6_cidr": 12
    },
    "files": {
      "trs": "release/tachyon/cs2_dota2.trs",
      "srs": "release/sing-box/cs2_dota2.srs",
      "json": "release/json/cs2_dota2.json",
      "domains": "release/domains/cs2_dota2.lst",
      "subnets": "release/subnets/cs2_dota2.lst"
    },
    "fallback_srs": "https://github.com/Dushnilin/tachyon-lists/releases/latest/download/cs2_dota2.srs"
  },
  {
    "id": "survival_coop",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Dead by Daylight, Rust, Hunt: Showdown, Helldivers 2, Palworld и кооп-выживачи",
    "description": "[Маршрут: В Прокси / VPN или Desync] Серверы входа, инвентаря и матчмейкинга популярных мультиплеерных экшенов и кооп-игр, размещённых на инфраструктуре Amazon AWS / GameLift и Hetzner: Dead by Daylight (bhvrdbd.com), Rust (facepunch.com, playrust.com), Hunt: Showdown 1896 (huntshowdown.com, crytek.com), Helldivers 2, Palworld, ARK, Valheim, Satisfactory, Deep Rock Galactic, Dune: Awakening и Sea of Thieves.",
    "counts": {
      "domain": 0,
      "domain_suffix": 50,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/survival_coop.trs",
      "srs": "release/sing-box/survival_coop.srs",
      "json": "release/json/survival_coop.json",
      "domains": "release/domains/survival_coop.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/Dushnilin/tachyon-lists/releases/latest/download/survival_coop.srs"
  },
  {
    "id": "mmorpg",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "MMORPG — Path of Exile 1 & 2, Guild Wars 2, Final Fantasy XIV, ESO, Albion Online и Black Desert",
    "description": "[Маршрут: В Прокси / VPN] Серверы авторизации, патчеры и торговые площадки ведущих MMORPG: Path of Exile 1 и PoE 2 (pathofexile.com, poecdn.com, grindinggear.com), Guild Wars 2 (guildwars2.com, arena.net, ncsoft.com), Final Fantasy XIV (finalfantasyxiv.com, sqex.com), The Elder Scrolls Online (elderscrollsonline.com), Albion Online (albiononline.com), Black Desert, EVE Online, Star Citizen, Lost Ark и RuneScape.",
    "counts": {
      "domain": 0,
      "domain_suffix": 40,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/mmorpg.trs",
      "srs": "release/sing-box/mmorpg.srs",
      "json": "release/json/mmorpg.json",
      "domains": "release/domains/mmorpg.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/Dushnilin/tachyon-lists/releases/latest/download/mmorpg.srs"
  },
  {
    "id": "netease_tencent_games",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Marvel Rivals, Delta Force, Once Human, Arena Breakout и Naraka (NetEase и Level Infinite)",
    "description": "[Маршрут: В Прокси / VPN] Игровые бэкенды, лаунчеры, античиты и CDN-серверы глобальных хитов от NetEase Games и Tencent Level Infinite: Marvel Rivals (marvelrivals.com), Delta Force (playdeltaforce.com), Once Human (oncehuman.game), Arena Breakout: Infinite, Naraka: Bladepoint, FragPunk, PUBG Mobile, NIKKE и Strinova (netease.com, easebar.com, loadingbay.com, intlgame.com, proximabeta.com).",
    "counts": {
      "domain": 0,
      "domain_suffix": 146,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/netease_tencent_games.trs",
      "srs": "release/sing-box/netease_tencent_games.srs",
      "json": "release/json/netease_tencent_games.json",
      "domains": "release/domains/netease_tencent_games.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/netease.srs"
  },
  {
    "id": "japanese_publishers",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Capcom, Bandai Namco, FromSoftware, SEGA, Square Enix и Konami — Elden Ring, Monster Hunter, RE",
    "description": "[Маршрут: В Прокси / VPN] Онлайн-сервисы и серверы коопа/матчмейкинга японских игровых издателей: FromSoftware и Bandai Namco (Elden Ring, Elden Ring Nightreign, Dark Souls, Armored Core VI — fromsoftware-game.jp, bandainamcoent.com), Capcom (Monster Hunter Wilds / World, Resident Evil, Capcom ID — capcom.com), SEGA и Atlus (Sonic, Like a Dragon, Persona — sega.com), Square Enix и Konami (eFootball, Yu-Gi-Oh!, Metal Gear).",
    "counts": {
      "domain": 0,
      "domain_suffix": 50,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/japanese_publishers.trs",
      "srs": "release/sing-box/japanese_publishers.srs",
      "json": "release/json/japanese_publishers.json",
      "domains": "release/domains/japanese_publishers.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/konami.srs"
  },
  {
    "id": "fighting_racing",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Файтинги и симрейсинг — Mortal Kombat 1 (WB Games), Tekken 8, Street Fighter 6, iRacing и Assetto Corsa",
    "description": "[Маршрут: Только в Прокси / VPN — WB Games блокирует РФ по IP] Серверы онлайна и профилей файтингов и гоночных симуляторов: Mortal Kombat 1 / 11 и игры Warner Bros. Games (wbgames.com, wbplay.com, agoragames.com — закрыты для российских IP), Tekken 8, Street Fighter 6 (buckler.capcom.com), Guilty Gear Strive, а также симрейсинг iRacing (iracing.com), Assetto Corsa / LFM (lowfuelmotorsport.com), Le Mans Ultimate, RaceRoom, Fanatec, Moza Racing и Simagic.",
    "counts": {
      "domain": 2,
      "domain_suffix": 37,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/fighting_racing.trs",
      "srs": "release/sing-box/fighting_racing.srs",
      "json": "release/json/fighting_racing.json",
      "domains": "release/domains/fighting_racing.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/wbgames.srs"
  },
  {
    "id": "strategy_sim",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Стратегии и авиасимуляторы — Paradox (HOI4, Stellaris, Cities: Skylines), Civilization и MS Flight Simulator",
    "description": "[Маршрут: В Прокси / VPN] Лаунчеры, моды и мультиплеер глобальных стратегий и симуляторов: Paradox Interactive (Hearts of Iron IV, Stellaris, Europa Universalis IV, Crusader Kings III, Cities: Skylines — paradoxinteractive.com, paradoxplaza.com), Sid Meier's Civilization (2K), Age of Empires, Total War, Euro Truck Simulator 2 (TruckersMP), а также серверы фотограмметрии, погоды и навигации Microsoft Flight Simulator 2020/2024, X-Plane, Navigraph и VATSIM.",
    "counts": {
      "domain": 2,
      "domain_suffix": 108,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/strategy_sim.trs",
      "srs": "release/sing-box/strategy_sim.srs",
      "json": "release/json/strategy_sim.json",
      "domains": "release/domains/strategy_sim.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/category-flight-simulator.srs"
  },
  {
    "id": "meta_quest",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Meta Quest (Oculus) и Pico VR — активация VR-шлемов, обновление прошивок и магазин игр",
    "description": "[Маршрут: Только в Прокси / VPN — обязательно для работы Meta Quest в РФ] Выделенный список доменов VR-экосистемы Meta Quest 2 / 3 / 3S / Pro (oculus.com, oculuscdn.com, meta.com, graph.oculus.com, securecdn.oculus.com), Pico VR (picoxr.com) и SideQuest. Позволяет активировать шлем, обновлять прошивку Horizon OS и скачивать игры на полной скорости, не проксируя весь остальной трафик Instagram/Facebook.",
    "counts": {
      "domain": 0,
      "domain_suffix": 27,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/meta_quest.trs",
      "srs": "release/sing-box/meta_quest.srs",
      "json": "release/json/meta_quest.json",
      "domains": "release/domains/meta_quest.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/oculus.srs"
  },
  {
    "id": "chess_boardgames",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Шахматы, настолки и викторины — Chess.com, Lichess, GeoGuessr, D&D Beyond, Roll20 и BoardGameArena",
    "description": "[Маршрут: В Прокси / VPN или Desync] Крупнейший шахматный портал Chess.com (chess.com, chesscomfiles.com), Lichess (lichess.org), географическая игра GeoGuessr (geoguessr.com), виртуальные столы для настольных и ролевых игр D&D Beyond (dndbeyond.com, wizards.com), Roll20 (roll20.net), Foundry VTT, BoardGameArena и Tabletopia.",
    "counts": {
      "domain": 0,
      "domain_suffix": 32,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/chess_boardgames.trs",
      "srs": "release/sing-box/chess_boardgames.srs",
      "json": "release/json/chess_boardgames.json",
      "domains": "release/domains/chess_boardgames.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/chesscom.srs"
  },
  {
    "id": "gaming_mods_stats",
    "group": "gaming",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Менеджеры модов, оверлеи и стат-трекеры — Thunderstore, Overwolf, WeMod, Tracker.gg, OP.GG и HLTV",
    "description": "[Маршрут: В Прокси / VPN] Платформы моддинга, игровых оверлеев, трейнеров и киберспортивной статистики за CDN Cloudflare и с региональными ограничениями: Thunderstore Mod Manager / r2modman (thunderstore.io, gcdn.thunderstore.io), Overwolf (overwolf.com), WeMod, ModDB, GameBanana, SteamDB, Tracker.gg, OP.GG, U.GG, Mobalytics, Dotabuff, OpenDota, Stratz, Leetify, Maxroll, Wowhead, Poe.ninja и HLTV.org.",
    "counts": {
      "domain": 0,
      "domain_suffix": 72,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/gaming_mods_stats.trs",
      "srs": "release/sing-box/gaming_mods_stats.srs",
      "json": "release/json/gaming_mods_stats.json",
      "domains": "release/domains/gaming_mods_stats.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/category-enhance-gaming.srs"
  },
  {
    "id": "apple",
    "group": "tech",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Apple — App Store, iCloud, обновления iOS/macOS, Apple Music, TV+ и Intelligence",
    "description": "[Маршрут: Напрямую (Direct) или в Прокси для Apple Intelligence] Все домены экосистемы Apple: apple.com, icloud.com, mzstatic.com, aaplimg.com, cdn-apple.com, itunes.apple.com и серверы Apple Intelligence / Siri.",
    "counts": {
      "domain": 45,
      "domain_suffix": 1545,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/apple.trs",
      "srs": "release/sing-box/apple.srs",
      "json": "release/json/apple.json",
      "domains": "release/domains/apple.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/hydraponique/roscomvpn-geosite/master/release/sing-box/apple.srs"
  },
  {
    "id": "microsoft",
    "group": "tech",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Microsoft — Windows Update, Office 365, OneDrive, Xbox Live, Teams и Azure",
    "description": "[Маршрут: В Прокси / VPN (для Copilot, Xbox и ISO Windows) или Direct] Все сервисы Microsoft: microsoft.com, live.com, office.com, sharepoint.com, onedrive.com, xbox.com, microsoftonline.com, visualstudio.com и серверы обновлений Windows.",
    "counts": {
      "domain": 16,
      "domain_suffix": 630,
      "domain_keyword": 3,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/microsoft.trs",
      "srs": "release/sing-box/microsoft.srs",
      "json": "release/json/microsoft.json",
      "domains": "release/domains/microsoft.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/hydraponique/roscomvpn-geosite/master/release/sing-box/microsoft.srs"
  },
  {
    "id": "google_play",
    "group": "tech",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Google Play — магазин приложений Android, обновления и APK-серверы (gvt1/gvt2)",
    "description": "[Маршрут: В Прокси / VPN (для платных приложений и смены региона) или Direct] Домены магазина Google Play и скачивания приложений Android: play.google.com, play.googleapis.com, android.clients.google.com, gvt1.com, gvt2.com и xn--ngstr-lra8j.com.",
    "counts": {
      "domain": 0,
      "domain_suffix": 32,
      "domain_keyword": 0,
      "domain_regex": 2,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/google_play.trs",
      "srs": "release/sing-box/google_play.srs",
      "json": "release/json/google_play.json",
      "domains": "release/domains/google_play.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/google_play.srs"
  },
  {
    "id": "github",
    "group": "tech",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "GitHub — репозитории, GitHub Actions, Packages, Pages, Raw и Gist",
    "description": "[Маршрут: В Прокси / VPN (для Copilot и стабильной загрузки релизов) или Direct] Все домены GitHub: github.com, githubusercontent.com, githubassets.com, ghcr.io, github.io, gist.github.com и api.github.com.",
    "counts": {
      "domain": 26,
      "domain_suffix": 33,
      "domain_keyword": 0,
      "domain_regex": 1,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/github.trs",
      "srs": "release/sing-box/github.srs",
      "json": "release/json/github.json",
      "domains": "release/domains/github.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/github.srs"
  },
  {
    "id": "docker",
    "group": "tech",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Docker — Docker Hub, реестр образов (registry-1.docker.io) и пакеты",
    "description": "[Маршрут: Только в Прокси / VPN — геоблок по IP] Домены Docker, закрывшие скачивание контейнеров с российских IP: docker.com, hub.docker.com, docker.io, registry-1.docker.io, production.cloudflare.docker.com и download.docker.com.",
    "counts": {
      "domain": 2,
      "domain_suffix": 4,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/docker.trs",
      "srs": "release/sing-box/docker.srs",
      "json": "release/json/docker.json",
      "domains": "release/domains/docker.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-docker.srs"
  },
  {
    "id": "hodca",
    "group": "tech",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Центры сертификации (CA) — проверка SSL/TLS (OCSP / CRL): DigiCert, Sectigo, Let's Encrypt",
    "description": "[Маршрут: В Прокси / VPN] Серверы проверки отзыва SSL-сертификатов (OCSP и CRL) мировых удостоверяющих центров: DigiCert, Sectigo, Comodo, GlobalSign, Entrust, Let's Encrypt и Amazon Trust (устраняет зависания при открытии HTTPS-сайтов из-за геоблока OCSP).",
    "counts": {
      "domain": 0,
      "domain_suffix": 249,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/hodca.trs",
      "srs": "release/sing-box/hodca.srs",
      "json": "release/json/hodca.json",
      "domains": "release/domains/hodca.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/hodca.srs"
  },
  {
    "id": "jetbrains",
    "group": "tech",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "JetBrains, Android Studio и Gradle — IDE (IntelliJ, PyCharm, WebStorm, RustRover), плагины и SDK",
    "description": "[Маршрут: Только в Прокси / VPN — геоблок по IP] Все домены экосистемы JetBrains (jetbrains.com, marketplace.jetbrains.com, download.jetbrains.com, account.jetbrains.com, kotlinlang.org), загрузки Android Studio / SDK (dl.google.com, developer.android.com), Gradle и Maven Central.",
    "counts": {
      "domain": 0,
      "domain_suffix": 34,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/jetbrains.trs",
      "srs": "release/sing-box/jetbrains.srs",
      "json": "release/json/jetbrains.json",
      "domains": "release/domains/jetbrains.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-jetbrains.srs"
  },
  {
    "id": "gitlab_notion",
    "group": "tech",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "GitLab, Atlassian (Jira, Confluence, Trello), Notion, Miro и Linear — таск-трекеры и DevOps",
    "description": "[Маршрут: Только в Прокси / VPN — геоблок по IP] Рабочие пространства, репозитории и сервисы мониторинга, закрывшие доступ из РФ: GitLab (gitlab.com), Atlassian (Jira, Confluence, Bitbucket, Trello), Notion (notion.so), Miro, Linear, Asana, ClickUp, Monday, Airtable, Postman, Sentry, Datadog и Grafana Cloud.",
    "counts": {
      "domain": 1,
      "domain_suffix": 51,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/gitlab_notion.trs",
      "srs": "release/sing-box/gitlab_notion.srs",
      "json": "release/json/gitlab_notion.json",
      "domains": "release/domains/gitlab_notion.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-notion.srs"
  },
  {
    "id": "figma_adobe",
    "group": "tech",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Figma, Canva, Adobe Creative Cloud, Framer и Webflow — дизайн, вёрстка, 3D и фотостоки",
    "description": "[Маршрут: Только в Прокси / VPN — геоблок по IP] Платформы UI/UX-дизайна, графики и стоков: Figma (figma.com), Canva (canva.com), Adobe Creative Cloud & Firefly AI (adobe.com, adobe.io, behance.net), Framer, Webflow, Dribbble, Freepik, Flaticon, Envato, Shutterstock, Unsplash и Autodesk.",
    "counts": {
      "domain": 3,
      "domain_suffix": 176,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/figma_adobe.trs",
      "srs": "release/sing-box/figma_adobe.srs",
      "json": "release/json/figma_adobe.json",
      "domains": "release/domains/figma_adobe.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-figma.srs"
  },
  {
    "id": "pkg_registries",
    "group": "tech",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Пакетные менеджеры и реестры — HashiCorp (Terraform), npm, PyPI, Crates.io, Go, Brew, OpenWrt",
    "description": "[Маршрут: В Прокси / VPN] Репозитории пакетов, библиотек и Linux-дистрибутивов: HashiCorp (Terraform, Vagrant, Vault — жёсткий геоблок РФ), npm, Yarn, pnpm, Bun, Deno, jsDelivr, PyPI, Anaconda, PyTorch, Rust Crates.io, Go Proxy, NuGet, Packagist, Homebrew, GHCR, Quay.io, Kubernetes (k8s.io), Arch, Alpine, Debian/Ubuntu и OpenWrt.",
    "counts": {
      "domain": 0,
      "domain_suffix": 65,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/pkg_registries.trs",
      "srs": "release/sing-box/pkg_registries.srs",
      "json": "release/json/pkg_registries.json",
      "domains": "release/domains/pkg_registries.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-hashicorp.srs"
  },
  {
    "id": "google_services",
    "group": "tech",
    "kind": "domains",
    "recommended_action": "direct",
    "title": "Сервисы Google (Почта, Диск, Документы, Карты, Переводчик, Календарь — без YouTube и Gemini)",
    "description": "[Маршрут: Напрямую (Direct) или В Прокси / VPN по выбору] Основная экосистема поиска и офисных сервисов Google (google.com, gmail.com, drive.google.com, docs.google.com, maps.google.com, translate.google.com, gstatic.com, googleapis.com, googleusercontent.com), из которой исключены домены YouTube (youtube.com, googlevideo.com) и нейросетей Google AI (gemini.google.com, aistudio.google.com).",
    "counts": {
      "domain": 19,
      "domain_suffix": 819,
      "domain_keyword": 0,
      "domain_regex": 2,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/google_services.trs",
      "srs": "release/sing-box/google_services.srs",
      "json": "release/json/google_services.json",
      "domains": "release/domains/google_services.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/google.srs"
  },
  {
    "id": "captcha_auth",
    "group": "tech",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Капчи и единый вход (SSO) — Cloudflare Turnstile, Google reCAPTCHA, hCaptcha, Arkose Labs и Auth0",
    "description": "[Маршрут: В Прокси / VPN или Direct (в зависимости от сайта)] Виджеты проверки на робота и провайдеры единой авторизации (SSO / OAuth / Passkeys): Cloudflare Turnstile (challenges.cloudflare.com), hCaptcha (hcaptcha.com), Google reCAPTCHA (recaptcha.net), Arkose Labs / FunCaptcha (arkoselabs.com, funcaptcha.com — капча в Steam, Roblox, EA, GitHub, OpenAI), GeeTest, DataDome, Auth0, Okta и Clerk.",
    "counts": {
      "domain": 0,
      "domain_suffix": 25,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/captcha_auth.trs",
      "srs": "release/sing-box/captcha_auth.srs",
      "json": "release/json/captcha_auth.json",
      "domains": "release/domains/captcha_auth.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/Dushnilin/tachyon-lists/releases/latest/download/captcha_auth.srs"
  },
  {
    "id": "cloud_gaming_remote",
    "group": "tech",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Облачный гейминг и удалённый рабочий стол — GeForce NOW, Boosteroid, Parsec, TeamViewer, AnyDesk и RustDesk",
    "description": "[Маршрут: В Прокси / VPN] Сервисы облачного гейминга и удалённого управления ПК: NVIDIA GeForce NOW (geforcenow.com, nvidiagrid.net — проверяет зарубежный IP только при входе и старте игры, после чего видеопоток идёт напрямую), Boosteroid, Parsec (parsec.app), Shadow, а также TeamViewer, AnyDesk (anydesk.com), RustDesk, NoMachine, Tailscale и ZeroTier.",
    "counts": {
      "domain": 4,
      "domain_suffix": 93,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/cloud_gaming_remote.trs",
      "srs": "release/sing-box/cloud_gaming_remote.srs",
      "json": "release/json/cloud_gaming_remote.json",
      "domains": "release/domains/cloud_gaming_remote.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/category-remote-control.srs"
  },
  {
    "id": "cloud_storage",
    "group": "tech",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Облачные хранилища и файлообменники — MEGA, Dropbox, WeTransfer, Pixeldrain, GoFile, Catbox и MediaFire",
    "description": "[Маршрут: В Прокси / VPN или Desync] Зарубежные облачные диски и популярные файлообменники, где публикуют прошивки, моды и рабочие архивы: MEGA (mega.nz, mega.co.nz, mega.io), Dropbox (dropbox.com), WeTransfer (wetransfer.com, we.tl), Pixeldrain (pixeldrain.com), GoFile (gofile.io), Catbox (catbox.moe), MediaFire, Box.com, pCloud, Sync.com и TeraBox.",
    "counts": {
      "domain": 3,
      "domain_suffix": 96,
      "domain_keyword": 3,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/cloud_storage.trs",
      "srs": "release/sing-box/cloud_storage.srs",
      "json": "release/json/cloud_storage.json",
      "domains": "release/domains/cloud_storage.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/category-netdisk-!cn.srs"
  },
  {
    "id": "gamedev_3d",
    "group": "tech",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "3D-графика, CAD и геймдев — Unity Hub, Autodesk, Blender, Chaos (V-Ray/Corona), Maxon, ArtStation и Fab",
    "description": "[Маршрут: Только в Прокси / VPN — геоблок по IP] Профессиональный софт для 3D-моделирования, рендера, CAD и разработки игр: Unity Engine, Unity Hub и Asset Store (unity.com, unity3d.com — закрыты для RU IP), Autodesk (AutoCAD, 3ds Max, Maya, Revit, Fusion 360 — autodesk.com), Chaos Group (V-Ray, Corona, Enscape), Maxon (Cinema 4D, Redshift, ZBrush), Blender, Godot, SideFX Houdini, Quixel Megascans / Fab.com, Sketchfab, ArtStation, Poly Haven и Printables.",
    "counts": {
      "domain": 0,
      "domain_suffix": 609,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/gamedev_3d.trs",
      "srs": "release/sing-box/gamedev_3d.srs",
      "json": "release/json/gamedev_3d.json",
      "domains": "release/domains/gamedev_3d.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/unity.srs"
  },
  {
    "id": "security_passwords",
    "group": "tech",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Менеджеры паролей, защищённая почта и антивирусы — Bitwarden, 1Password, Proton, VirusTotal и Malwarebytes",
    "description": "[Маршрут: В Прокси / VPN] Менеджеры паролей и ключей: Bitwarden (bitwarden.com, bitwarden.eu), 1Password (1password.com), NordPass, Dashlane, Keeper, Enpass; защищённая экосистема Proton (Proton Mail, Proton Pass, Proton Drive — proton.me, protonmail.com), Tuta (tuta.com); облачный сканер VirusTotal и обновления баз зарубежных антивирусов (Malwarebytes, Avast, AVG, ESET NOD32, Bitdefender, Norton, Avira).",
    "counts": {
      "domain": 3,
      "domain_suffix": 135,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/security_passwords.trs",
      "srs": "release/sing-box/security_passwords.srs",
      "json": "release/json/security_passwords.json",
      "domains": "release/domains/security_passwords.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/category-password-management.srs"
  },
  {
    "id": "smarthome_iot",
    "group": "tech",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Умный дом и 3D-печать — Home Assistant, HACS, Bambu Lab, Tuya (Smart Life), Aqara и Roborock",
    "description": "[Маршрут: В Прокси / VPN] Облачные сервисы и репозитории умного дома и 3D-принтеров: облако 3D-печати Bambu Lab / MakerWorld (bambulab.com, bblmw.com, makerworld.com — отправка заданий из Bambu Studio и видеопоток камеры через AWS), Creality Cloud, Prusa; экосистема Home Assistant и Nabu Casa (home-assistant.io, nabu.casa, esphome.io, zigbee2mqtt.io); глобальные облака Tuya / Smart Life, eWeLink (Sonoff), Aqara, Roborock, Dreame и Philips Hue.",
    "counts": {
      "domain": 0,
      "domain_suffix": 54,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/smarthome_iot.trs",
      "srs": "release/sing-box/smarthome_iot.srs",
      "json": "release/json/smarthome_iot.json",
      "domains": "release/domains/smarthome_iot.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/xiaomi-iot.srs"
  },
  {
    "id": "smarttv_apps",
    "group": "tech",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Smart TV: Samsung Tizen и LG webOS — разблокировка Smart Hub, смена региона и магазины приложений ТВ",
    "description": "[Маршрут: Только в Прокси / VPN (на нужный регион при настройке/активации ТВ)] Серверы проверки геолокации, активации Smart Hub и каталогов приложений телевизоров Samsung Smart TV (Tizen OS: samsungcloudsolution.com, samsungotn.net, samsungqbe.com, samsungosp.com) и LG Smart TV (webOS / LG Content Store: lgappstv.com, lgtvsdp.com, lgtvcommon.com). Незаменимо для разблокировки «серых» телевизоров параллельного импорта.",
    "counts": {
      "domain": 1,
      "domain_suffix": 50,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/smarttv_apps.trs",
      "srs": "release/sing-box/smarttv_apps.srs",
      "json": "release/json/smarttv_apps.json",
      "domains": "release/domains/smarttv_apps.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/samsung.srs"
  },
  {
    "id": "smart_cars",
    "group": "tech",
    "kind": "domains",
    "recommended_action": "direct",
    "title": "Умные автомобили и электрокары — LiXiang (Li Auto), Zeekr, BYD, Voyah, Geely, Xiaomi Auto, Tesla и BMW",
    "description": "[Маршрут: Напрямую (Direct) или в китайский/целевой прокси] Серверы телематики, OTA-обновлений, мастер-аккаунтов и штатной навигации современных автомобилей: китайские электрокары и гибриды LiXiang / Li Auto (lixiang.com, chj.com), Zeekr (zeekrlife.com, zeekr.com), BYD, Voyah, Geely, Changan, Xiaomi SU7, NIO, XPeng, а также приложения и облака Tesla (tesla.com), BMW (MyBMW / ConnectedDrive) и Mercedes me. Позволяет на роутере в авто не пускать китайскую телематику в европейский VPN во избежание гео-блокировки экранов.",
    "counts": {
      "domain": 0,
      "domain_suffix": 813,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/smart_cars.trs",
      "srs": "release/sing-box/smart_cars.srs",
      "json": "release/json/smart_cars.json",
      "domains": "release/domains/smart_cars.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/category-automobile-cn.srs"
  },
  {
    "id": "linux_repos",
    "group": "tech",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Репозитории и пакеты Linux — Flathub, Snapcraft, Ubuntu PPA (Launchpad), Arch AUR, Proxmox, RedHat и Fedora",
    "description": "[Маршрут: В Прокси / VPN] Пакетные репозитории, магазины приложений Linux и серверные дистрибутивы с региональными ограничениями доступа (Red Hat, Fedora, Canonical Launchpad, Flathub): Flathub / Flatpak (flathub.org), Snapcraft (snapcraft.io), Ubuntu / Launchpad PPA (launchpad.net), Arch Linux & AUR (archlinux.org), Proxmox VE (proxmox.com), Red Hat (redhat.com), Fedora, Debian, Alpine, Kali и NixOS.",
    "counts": {
      "domain": 0,
      "domain_suffix": 50,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/linux_repos.trs",
      "srs": "release/sing-box/linux_repos.srs",
      "json": "release/json/linux_repos.json",
      "domains": "release/domains/linux_repos.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/ubuntu.srs"
  },
  {
    "id": "cloudflare",
    "group": "infra",
    "kind": "subnets",
    "recommended_action": "proxy",
    "title": "Cloudflare — IPv4/IPv6-подсети глобальной сети CDN и защиты от DDoS",
    "description": "[Маршрут: В Прокси / VPN или Desync] Официальные IPv4/IPv6-подсети CDN Cloudflare для маршрутизации ресурсов, использующих TLS ECH (Encrypted Client Hello) и проксирование Cloudflare.",
    "counts": {
      "domain": 0,
      "domain_suffix": 4,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 708,
      "ipv6_cidr": 80
    },
    "files": {
      "trs": "release/tachyon/cloudflare.trs",
      "srs": "release/sing-box/cloudflare.srs",
      "json": "release/json/cloudflare.json",
      "domains": "release/domains/cloudflare.lst",
      "subnets": "release/subnets/cloudflare.lst"
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/cloudflare.srs"
  },
  {
    "id": "cloudfront",
    "group": "infra",
    "kind": "subnets",
    "recommended_action": "proxy",
    "title": "Amazon CloudFront — IP-подсети глобальной CDN-сети AWS",
    "description": "[Маршрут: В Прокси / VPN] Диапазоны IP-адресов CDN Amazon CloudFront, на которых работают тысячи зарубежных веб-приложений, игровых сервисов и API.",
    "counts": {
      "domain": 0,
      "domain_suffix": 1,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 183,
      "ipv6_cidr": 64
    },
    "files": {
      "trs": "release/tachyon/cloudfront.trs",
      "srs": "release/sing-box/cloudfront.srs",
      "json": "release/json/cloudfront.json",
      "domains": "release/domains/cloudfront.lst",
      "subnets": "release/subnets/cloudfront.lst"
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/cloudfront.srs"
  },
  {
    "id": "fastly",
    "group": "infra",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Fastly CDN — домены и инфраструктура сети доставки контента Fastly",
    "description": "[Маршрут: В Прокси / VPN] Домены и подсети CDN-провайдера Fastly (fastly.net, fastlylb.net, fsdn.com), используемого Reddit, GitHub, StackOverflow, PyPI и многими западными сервисами.",
    "counts": {
      "domain": 0,
      "domain_suffix": 7,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 57,
      "ipv6_cidr": 39
    },
    "files": {
      "trs": "release/tachyon/fastly.trs",
      "srs": "release/sing-box/fastly.srs",
      "json": "release/json/fastly.json",
      "domains": "release/domains/fastly.lst",
      "subnets": "release/subnets/fastly.lst"
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-fastly.srs"
  },
  {
    "id": "hetzner",
    "group": "infra",
    "kind": "subnets",
    "recommended_action": "proxy",
    "title": "Hetzner — IP-подсети европейских датацентров Hetzner (Германия и Финляндия)",
    "description": "[Маршрут: В Прокси / VPN] Подсети европейских датацентров хостинг-провайдера Hetzner Online (Германия и Финляндия).",
    "counts": {
      "domain": 0,
      "domain_suffix": 1,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 82,
      "ipv6_cidr": 4
    },
    "files": {
      "trs": "release/tachyon/hetzner.trs",
      "srs": "release/sing-box/hetzner.srs",
      "json": "release/json/hetzner.json",
      "domains": "release/domains/hetzner.lst",
      "subnets": "release/subnets/hetzner.lst"
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/hetzner.srs"
  },
  {
    "id": "ovh",
    "group": "infra",
    "kind": "subnets",
    "recommended_action": "proxy",
    "title": "OVHcloud — IP-подсети европейских датацентров OVH",
    "description": "[Маршрут: В Прокси / VPN] Подсети облачного провайдера OVHcloud, на которых размещено множество игровых серверов, веб-проектов и API.",
    "counts": {
      "domain": 0,
      "domain_suffix": 1,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 653,
      "ipv6_cidr": 6
    },
    "files": {
      "trs": "release/tachyon/ovh.trs",
      "srs": "release/sing-box/ovh.srs",
      "json": "release/json/ovh.json",
      "domains": "release/domains/ovh.lst",
      "subnets": "release/subnets/ovh.lst"
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/ovh.srs"
  },
  {
    "id": "digitalocean",
    "group": "infra",
    "kind": "subnets",
    "recommended_action": "proxy",
    "title": "DigitalOcean — IP-подсети облачного хостинга DigitalOcean",
    "description": "[Маршрут: В Прокси / VPN] Подсети глобальной облачной инфраструктуры и датацентров DigitalOcean.",
    "counts": {
      "domain": 0,
      "domain_suffix": 1,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 170,
      "ipv6_cidr": 13
    },
    "files": {
      "trs": "release/tachyon/digitalocean.trs",
      "srs": "release/sing-box/digitalocean.srs",
      "json": "release/json/digitalocean.json",
      "domains": "release/domains/digitalocean.lst",
      "subnets": "release/subnets/digitalocean.lst"
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/digitalocean.srs"
  },
  {
    "id": "speedtest",
    "group": "infra",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Speedtest и проверка IP — Ookla Speedtest, Fast.com, 2ip, Whoer, BrowserLeaks и Ping.pe",
    "description": "[Маршрут: В Прокси / VPN (для теста скорости и IP туннеля) или Direct] Сервисы замера скорости интернета, проверки внешнего IP-адреса, DNS-утечек и маршрутов: Speedtest (speedtest.net, ookla.com), Fast.com, Cloudflare Speed, 2ip.ru / 2ip.io, Whoer.net, BrowserLeaks, IPLeak, IPinfo, Check-Host и Ping.pe.",
    "counts": {
      "domain": 1,
      "domain_suffix": 52,
      "domain_keyword": 0,
      "domain_regex": 1,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/speedtest.trs",
      "srs": "release/sing-box/speedtest.srs",
      "json": "release/json/speedtest.json",
      "domains": "release/domains/speedtest.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-ookla-speedtest.srs"
  },
  {
    "id": "doh_dot_dns",
    "group": "infra",
    "kind": "mixed",
    "recommended_action": "proxy",
    "title": "Публичные шифрованные DNS (DoH / DoT) — Cloudflare 1.1.1.1, Google 8.8.8.8, Quad9, AdGuard и NextDNS",
    "description": "[Маршрут: В Прокси / VPN (для туннелирования DoH) или Блокировать (Block — для принудительного использования локального DNS роутера)] Полная база публичных серверов DNS-over-HTTPS (DoH) и DNS-over-TLS (DoT), включая домены и IP-адреса резолверов Cloudflare (1.1.1.1, cloudflare-dns.com), Google (8.8.8.8, dns.google), Quad9 (9.9.9.9, dns.quad9.net), AdGuard DNS, NextDNS, OpenDNS, Control D и Mullvad DNS.",
    "counts": {
      "domain": 10,
      "domain_suffix": 3562,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 28,
      "ipv6_cidr": 10
    },
    "files": {
      "trs": "release/tachyon/doh_dot_dns.trs",
      "srs": "release/sing-box/doh_dot_dns.srs",
      "json": "release/json/doh_dot_dns.json",
      "domains": "release/domains/doh_dot_dns.lst",
      "subnets": "release/subnets/doh_dot_dns.lst"
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/category-doh.srs"
  },
  {
    "id": "vps_clouds",
    "group": "infra",
    "kind": "subnets",
    "recommended_action": "proxy",
    "title": "Облачные хостинги (VPS) — IP-подсети Oracle Cloud, Vultr, Linode (Akamai), Scaleway и GCore",
    "description": "[Маршрут: В Прокси / VPN] Сводные IPv4/IPv6-подсети популярных зарубежных облачных провайдеров и VPS-хостингов: Oracle Cloud (AS31898), Vultr / Constant (AS20473), Linode / Akamai Connected Cloud (AS63949), Scaleway / Online.net (AS12876) и GCore Labs (AS199524) в дополнение к спискам Hetzner, OVH и DigitalOcean.",
    "counts": {
      "domain": 0,
      "domain_suffix": 0,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 2430,
      "ipv6_cidr": 1266
    },
    "files": {
      "trs": "release/tachyon/vps_clouds.trs",
      "srs": "release/sing-box/vps_clouds.srs",
      "json": "release/json/vps_clouds.json",
      "domains": null,
      "subnets": "release/subnets/vps_clouds.lst"
    },
    "fallback_srs": "https://github.com/Dushnilin/tachyon-lists/releases/latest/download/vps_clouds.srs"
  },
  {
    "id": "crypto",
    "group": "other",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Криптовалюты и Web3 — Bybit, Binance, OKX, Bitget, BingX, TradingView, CoinMarketCap и TON",
    "description": "[Маршрут: В Прокси / VPN (на статичный зарубежный IP) или Direct] Все ведущие криптобиржи, DEX, графики, аналитика и кошельки: Binance, Bybit, OKX, Bitget, BingX, KuCoin, Gate.io, HTX, MEXC, Kraken, Coinbase, Uniswap, Jupiter, Polymarket, TradingView, CoinMarketCap, CoinGecko, DeFiLlama, DexScreener, MetaMask, Phantom, Tonkeeper и RPC-ноды (Infura, Alchemy).",
    "counts": {
      "domain": 8,
      "domain_suffix": 289,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/crypto.trs",
      "srs": "release/sing-box/crypto.srs",
      "json": "release/json/crypto.json",
      "domains": "release/domains/crypto.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-category-cryptocurrency.srs"
  },
  {
    "id": "paypal_fintech",
    "group": "other",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "PayPal, Wise, Revolut и Stripe — международные платёжные системы, необанки и инвестиции",
    "description": "[Маршрут: Только в Прокси / VPN — геоблок по IP] Зарубежные финансовые сервисы, платёжные шлюзы и брокеры, блокирующие вход с российских IP: PayPal (paypal.com), Wise (wise.com), Revolut (revolut.com), Stripe (stripe.com), Payoneer, Skrill, Neteller, N26, Monzo, Interactive Brokers, Investing.com и Bloomberg.",
    "counts": {
      "domain": 1,
      "domain_suffix": 300,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/paypal_fintech.trs",
      "srs": "release/sing-box/paypal_fintech.srs",
      "json": "release/json/paypal_fintech.json",
      "domains": "release/domains/paypal_fintech.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-paypal.srs"
  },
  {
    "id": "news",
    "group": "other",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "СМИ и новости — зарубежные и независимые информационные издания и медиа",
    "description": "[Маршрут: В Прокси / VPN или Desync] Зарубежные и международные новостные агентства, издания и аналитические порталы.",
    "counts": {
      "domain": 0,
      "domain_suffix": 184,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/news.trs",
      "srs": "release/sing-box/news.srs",
      "json": "release/json/news.json",
      "domains": "release/domains/news.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/news.srs"
  },
  {
    "id": "torrent",
    "group": "other",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Торренты и трекеры — RuTracker, Rutor, NNM-Club, Kinozal, LostFilm, Nyaa",
    "description": "[Маршрут: В Desync / Zapret или Прокси] Торрент-трекеры, индексаторы и публичные анонсеры: RuTracker, Rutor, NNM-Club, Kinozal, Rustorka, Tapochek, LostFilm, The Pirate Bay, 1337x, YTS и Nyaa.",
    "counts": {
      "domain": 0,
      "domain_suffix": 418,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/torrent.trs",
      "srs": "release/sing-box/torrent.srs",
      "json": "release/json/torrent.json",
      "domains": "release/domains/torrent.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/hydraponique/roscomvpn-geosite/master/release/sing-box/torrent.srs"
  },
  {
    "id": "tor",
    "group": "other",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Tor и анонимайзеры — проект Tor, мосты, I2P, Freenet и Psiphon",
    "description": "[Маршрут: В Прокси / VPN] Домены и узлы Tor Project (torproject.org), каталогов мостов, оверлейных сетей I2P, Tails и Whonix.",
    "counts": {
      "domain": 0,
      "domain_suffix": 3,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 668,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/tor.trs",
      "srs": "release/sing-box/tor.srs",
      "json": "release/json/tor.json",
      "domains": "release/domains/tor.lst",
      "subnets": "release/subnets/tor.lst"
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-tor.srs"
  },
  {
    "id": "porn",
    "group": "other",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Сайты 18+ (Adult) — Pornhub, XVideos, xHamster, OnlyFans, Fansly, Chaturbate",
    "description": "[Маршрут: В Прокси / VPN или Desync] Крупнейшие сайты категории 18+, видео-CDN и платформы подписок с региональными ограничениями доступа.",
    "counts": {
      "domain": 3,
      "domain_suffix": 6531,
      "domain_keyword": 0,
      "domain_regex": 140,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/porn.trs",
      "srs": "release/sing-box/porn.srs",
      "json": "release/json/porn.json",
      "domains": "release/domains/porn.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/porn.srs"
  },
  {
    "id": "travel_booking",
    "group": "other",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Путешествия, отели и авиабилеты — Booking.com, Airbnb, TripAdvisor, Skyscanner, Agoda и Flightradar24",
    "description": "[Маршрут: Только в Прокси / VPN — геоблок по IP] Международные системы бронирования отелей, жилья и поиска авиабилетов: Booking.com (booking.com, bstatic.com — не показывает объекты размещения при входе с российских IP), Airbnb (airbnb.com, muscache.com — блокирует доступ из РФ и РБ), Agoda, Hostelworld, Expedia, Hotels.com, Trip.com, Skyscanner, Kayak, Momondo, TripAdvisor, а также радар полётов Flightradar24 и MarineTraffic.",
    "counts": {
      "domain": 0,
      "domain_suffix": 121,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/travel_booking.trs",
      "srs": "release/sing-box/travel_booking.srs",
      "json": "release/json/travel_booking.json",
      "domains": "release/domains/travel_booking.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/booking.srs"
  },
  {
    "id": "shopping_global",
    "group": "other",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Зарубежный шопинг и маркетплейсы — iHerb, Amazon, eBay, Poizon (Dewu), StockX, Farfetch, ASOS и IKEA",
    "description": "[Маршрут: Только в Прокси / VPN — региональные ограничения и геоблок] Иностранные интернет-магазины и маркетплейсы: iHerb (iherb.com), Amazon (amazon.com), eBay (ebay.com), маркетплейс Poizon / Dewu (dewu.com, poizon.com), StockX, GOAT, Chrono24, Farfetch, ASOS, Yoox, Net-a-Porter, Nike, Adidas, Uniqlo, Zara и IKEA.",
    "counts": {
      "domain": 0,
      "domain_suffix": 983,
      "domain_keyword": 0,
      "domain_regex": 3,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/shopping_global.trs",
      "srs": "release/sing-box/shopping_global.srs",
      "json": "release/json/shopping_global.json",
      "domains": "release/domains/shopping_global.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/amazon.srs"
  },
  {
    "id": "edtech_learning",
    "group": "other",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Обучение, курсы и IT-платформы — Coursera, Udemy, Quizlet, Duolingo, LeetCode, Kaggle и edX",
    "description": "[Маршрут: В Прокси / VPN] Образовательные платформы, языковые сервисы и тренажёры для программистов: Coursera (coursera.org), Udemy (udemy.com), edX, Udacity, Khan Academy, карточки для запоминания слов Quizlet (quizlet.com), Duolingo (duolingo.com), Babbel, Busuu, AnkiWeb, а также алгоритмические и Data Science платформы LeetCode (leetcode.com), Kaggle (kaggle.com), HackerRank, Codewars и freeCodeCamp.",
    "counts": {
      "domain": 0,
      "domain_suffix": 59,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/edtech_learning.trs",
      "srs": "release/sing-box/edtech_learning.srs",
      "json": "release/json/edtech_learning.json",
      "domains": "release/domains/edtech_learning.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/coursera.srs"
  },
  {
    "id": "freelance_remote",
    "group": "other",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Фриланс и удалённая работа за рубежом — Upwork, Fiverr, Freelancer, Toptal, Deel и Payoneer",
    "description": "[Маршрут: Только в Прокси / VPN — строгий геоблок по IP] Международные биржи фриланса, контрактов и глобального найма (требуют постоянный не-российский IP): Upwork (upwork.com), Fiverr (fiverr.com), Freelancer.com, Toptal, PeoplePerHour, Guru, 99designs, Behance, Dribbble, а также платформы оформления контрактов и выплат удалённым сотрудникам Deel (deel.com), Remote.com, Oyster HR и Payoneer.",
    "counts": {
      "domain": 0,
      "domain_suffix": 35,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/freelance_remote.trs",
      "srs": "release/sing-box/freelance_remote.srs",
      "json": "release/json/freelance_remote.json",
      "domains": "release/domains/freelance_remote.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/Dushnilin/tachyon-lists/releases/latest/download/freelance_remote.srs"
  },
  {
    "id": "sports_fitness",
    "group": "other",
    "kind": "domains",
    "recommended_action": "proxy",
    "title": "Спорт, велотрекеры и фитнес — Strava, Garmin Connect, Zwift, Komoot, Flashscore, F1 TV и UFC",
    "description": "[Маршрут: Только в Прокси / VPN] Спортивные трекеры, умные часы, велостанки и результаты матчей: Strava (strava.com), Garmin Connect (garmin.com, connect.garmin.com), виртуальный велотренажёр Zwift (zwift.com), велонавигатор Komoot, Wahoo, Whoop, MyFitnessPal, результаты матчей Flashscore (flashscore.com), Sofascore, Transfermarkt, F1 TV, UFC Fight Pass, NBA и NHL.",
    "counts": {
      "domain": 0,
      "domain_suffix": 53,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/sports_fitness.trs",
      "srs": "release/sing-box/sports_fitness.srs",
      "json": "release/json/sports_fitness.json",
      "domains": "release/domains/sports_fitness.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/Dushnilin/tachyon-lists/releases/latest/download/sports_fitness.srs"
  },
  {
    "id": "ads_hagezi_pro",
    "group": "block",
    "kind": "domains",
    "recommended_action": "block",
    "title": "Реклама и трекеры (Hagezi Pro) — блокировка рекламы, аналитики и фишинга",
    "description": "[Маршрут: Блокировать (Block)] Сбалансированный список блокировки рекламных сетей, счётчиков аналитики, мобильных баннеров и фишинга (Hagezi Multi PRO).",
    "counts": {
      "domain": 0,
      "domain_suffix": 247633,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/ads_hagezi_pro.trs",
      "srs": "release/sing-box/ads_hagezi_pro.srs",
      "json": "release/json/ads_hagezi_pro.json",
      "domains": "release/domains/ads_hagezi_pro.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/zxc-rv/ad-filter/releases/latest/download/adlist.srs"
  },
  {
    "id": "android_ads_block",
    "group": "block",
    "kind": "domains",
    "recommended_action": "block",
    "title": "Реклама в играх и приложениях Android (Block) — AdMob, Unity Ads, AppLovin, IronSource, Яндекс и MyTarget",
    "description": "[Маршрут: Блокировать (Block)] Вырезает полноэкранную видеорекламу между уровнями в мобильных играх и баннеры внутри бесплатных приложений на Android (AdAway Official + AdGuard Mobile Ads + все главные рекламные SDK: Google AdMob, Unity Ads, AppLovin MAX, IronSource LevelPlay, Vungle/Liftoff, Mintegral, Chartboost, Pangle, InMobi, AdColony, Tapjoy, Bigo Ads, BidMachine, Яндекс Реклама / Mobile Ads SDK и VK MyTarget).",
    "counts": {
      "domain": 75,
      "domain_suffix": 4984,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/android_ads_block.trs",
      "srs": "release/sing-box/android_ads_block.srs",
      "json": "release/json/android_ads_block.json",
      "domains": "release/domains/android_ads_block.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/Dushnilin/tachyon-lists/releases/latest/download/android_ads_block.srs"
  },
  {
    "id": "win_spy",
    "group": "block",
    "kind": "domains",
    "recommended_action": "block",
    "title": "Телеметрия Windows (Block) — домены слежки, диагностики и рекламы Microsoft",
    "description": "[Маршрут: Блокировать (Block)] Серверы сбора телеметрии, отчётов об ошибках и рекламных идентификаторов Windows 10/11 (vortex.data.microsoft.com, telecommand.telemetry.microsoft.com, settings-win.data.microsoft.com).",
    "counts": {
      "domain": 0,
      "domain_suffix": 328,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/win_spy.trs",
      "srs": "release/sing-box/win_spy.srs",
      "json": "release/json/win_spy.json",
      "domains": "release/domains/win_spy.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/hydraponique/roscomvpn-geosite/master/release/sing-box/win-spy.srs"
  },
  {
    "id": "xiaomi_smarttv_ads",
    "group": "block",
    "kind": "domains",
    "recommended_action": "block",
    "title": "Реклама Xiaomi HyperOS/MIUI и Smart TV (Block) — баннеры в телефонах Xiaomi и ТВ Samsung / LG",
    "description": "[Маршрут: Блокировать (Block)] Вырезает встроенную системную рекламу и телеметрию в прошивках Xiaomi / Poco / Redmi (MIUI и HyperOS: api.ad.xiaomi.com, tracking.miui.com, mistat.xiaomi.com), а также рекламные баннеры и ACR-слежку на телевизорах Samsung Smart TV (Tizen) и LG webOS.",
    "counts": {
      "domain": 0,
      "domain_suffix": 57,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/xiaomi_smarttv_ads.trs",
      "srs": "release/sing-box/xiaomi_smarttv_ads.srs",
      "json": "release/json/xiaomi_smarttv_ads.json",
      "domains": "release/domains/xiaomi_smarttv_ads.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/sing-box/rule-set-geosite/geosite-xiaomi@ads.srs"
  },
  {
    "id": "gambling_block",
    "group": "block",
    "kind": "domains",
    "recommended_action": "block",
    "title": "Казино, букмекеры и слоты (Block) — блокировка 1xBet, Stake, Melbet, Vulkan, Pin-Up и азартных игр",
    "description": "[Маршрут: Блокировать (Block)] Полная база онлайн-казино, нелегальных букмекеров, крипто-рулеток, слотов и их тысяч зеркал (Hagezi Gambling Medium + СНГ-казино: 1xBet, Melbet, Mostbet, Pin-Up, Vulkan, Vavada, Joycasino, Azino777, Stake, 1win, DragonMoney, Up-X и др.), агрессивно всплывающих на пиратских киносайтах.",
    "counts": {
      "domain": 0,
      "domain_suffix": 177940,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/gambling_block.trs",
      "srs": "release/sing-box/gambling_block.srs",
      "json": "release/json/gambling_block.json",
      "domains": "release/domains/gambling_block.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/Dushnilin/tachyon-lists/releases/latest/download/gambling_block.srs"
  },
  {
    "id": "phishing_malware_block",
    "group": "block",
    "kind": "domains",
    "recommended_action": "block",
    "title": "Фишинг, скам, крипто-дрейнеры и вредоносные сайты (Block) — защита без поломки кэшбэка",
    "description": "[Маршрут: Блокировать (Block)] Специализированный список блокировки фишинговых копий Steam / Telegram / Госуслуг / банков, телефонных мошенников, крипто-дрейнеров, ботнетов и вредоносных доменов (Hagezi Threat Intelligence Feeds Mini + Fake/Scam). Идеален для тех, кто не хочет включать полный AdBlock, чтобы не ломать реферальные ссылки и кэшбэк-сервисы, но хочет защитить домашнюю сеть от скама и вирусов.",
    "counts": {
      "domain": 0,
      "domain_suffix": 193431,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/phishing_malware_block.trs",
      "srs": "release/sing-box/phishing_malware_block.srs",
      "json": "release/json/phishing_malware_block.json",
      "domains": "release/domains/phishing_malware_block.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/Dushnilin/tachyon-lists/releases/latest/download/phishing_malware_block.srs"
  },
  {
    "id": "telemetry_mobile_block",
    "group": "block",
    "kind": "domains",
    "recommended_action": "block",
    "title": "Телеметрия Apple, Android, Huawei/Realme и мобильных SDK (Block) — AppsFlyer, Adjust, Branch и стучалки ОС",
    "description": "[Маршрут: Блокировать (Block)] Блокировка встроенной системной телеметрии смартфонов Apple iOS/macOS, Huawei EMUI/HarmonyOS, Realme/OPPO ColorOS, Vivo OriginOS, Amazon FireOS, а также самых навязчивых рекламных и трекинговых мобильных SDK внутри приложений (AppsFlyer, Adjust, Branch.io, Kochava, Singular, AppLovin, Unity Ads, IronSource, Vungle, Mintegral).",
    "counts": {
      "domain": 61,
      "domain_suffix": 1541,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/telemetry_mobile_block.trs",
      "srs": "release/sing-box/telemetry_mobile_block.srs",
      "json": "release/json/telemetry_mobile_block.json",
      "domains": "release/domains/telemetry_mobile_block.lst",
      "subnets": null
    },
    "fallback_srs": "https://github.com/Dushnilin/tachyon-lists/releases/latest/download/telemetry_mobile_block.srs"
  },
  {
    "id": "google_meet",
    "group": "internal",
    "kind": "mixed",
    "recommended_action": "proxy",
    "title": "Google Meet — видеоконференции и медиа-серверы",
    "description": "Домены и подсети видеозвонков Google Meet.",
    "counts": {
      "domain": 0,
      "domain_suffix": 4,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 3,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/google_meet.trs",
      "srs": "release/sing-box/google_meet.srs",
      "json": "release/json/google_meet.json",
      "domains": "release/domains/google_meet.lst",
      "subnets": "release/subnets/google_meet.lst"
    },
    "fallback_srs": "https://github.com/itdoginfo/allow-domains/releases/latest/download/google_meet.srs"
  },
  {
    "id": "geosite_ru",
    "group": "internal",
    "kind": "domains",
    "recommended_action": "direct",
    "title": "GeoSite RU — все домены российского сегмента",
    "description": "Системная база доменов Рунета для маршрутизации национального трафика.",
    "counts": {
      "domain": 3,
      "domain_suffix": 890,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 0,
      "ipv6_cidr": 0
    },
    "files": {
      "trs": "release/tachyon/geosite_ru.trs",
      "srs": "release/sing-box/geosite_ru.srs",
      "json": "release/json/geosite_ru.json",
      "domains": "release/domains/geosite_ru.lst",
      "subnets": null
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/category-ru.srs"
  },
  {
    "id": "geoip_ru",
    "group": "internal",
    "kind": "subnets",
    "recommended_action": "direct",
    "title": "GeoIP RU — IPv4/IPv6 подсети Российской Федерации",
    "description": "Системная база IP-подсетей России.",
    "counts": {
      "domain": 0,
      "domain_suffix": 0,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 12987,
      "ipv6_cidr": 12170
    },
    "files": {
      "trs": "release/tachyon/geoip_ru.trs",
      "srs": "release/sing-box/geoip_ru.srs",
      "json": "release/json/geoip_ru.json",
      "domains": null,
      "subnets": "release/subnets/geoip_ru.lst"
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geoip/ru.srs"
  },
  {
    "id": "geoip_us",
    "group": "internal",
    "kind": "subnets",
    "recommended_action": "proxy",
    "title": "GeoIP US — IPv4/IPv6 подсети США",
    "description": "Системная база IP-подсетей США.",
    "counts": {
      "domain": 0,
      "domain_suffix": 0,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 126927,
      "ipv6_cidr": 134361
    },
    "files": {
      "trs": "release/tachyon/geoip_us.trs",
      "srs": "release/sing-box/geoip_us.srs",
      "json": "release/json/geoip_us.json",
      "domains": null,
      "subnets": "release/subnets/geoip_us.lst"
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geoip/us.srs"
  },
  {
    "id": "geoip_cn",
    "group": "internal",
    "kind": "subnets",
    "recommended_action": "direct",
    "title": "GeoIP CN — IPv4/IPv6 подсети Китая",
    "description": "Системная база IP-подсетей КНР.",
    "counts": {
      "domain": 0,
      "domain_suffix": 0,
      "domain_keyword": 0,
      "domain_regex": 0,
      "ipv4_cidr": 6183,
      "ipv6_cidr": 3479
    },
    "files": {
      "trs": "release/tachyon/geoip_cn.trs",
      "srs": "release/sing-box/geoip_cn.srs",
      "json": "release/json/geoip_cn.json",
      "domains": null,
      "subnets": "release/subnets/geoip_cn.lst"
    },
    "fallback_srs": "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geoip/cn.srs"
  }
];
