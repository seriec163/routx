#!/bin/sh
# RoutX bootstrap installer.
#
# Использование:
#   curl -fsSL https://gitlab.com/artur.utenkov/router-control/-/raw/main/install.sh \
#     | sh -s -- --docker --domain panel.example.com --tls-email admin@example.com
#
#   curl ... | sh -s -- --native --db-url 'postgres://routx:pass@127.0.0.1:5432/routx'
#
# Скрипт только скачивает исходники в каталог установки и передаёт управление
# scripts/routx install. Все параметры установки — у routx install.

set -eu

DEFAULT_REPO="https://gitlab.com/artur.utenkov/router-control.git"
DEFAULT_REF="main"
REPO_URL="${ROUTX_REPO_URL:-$DEFAULT_REPO}"
REF="${ROUTX_REF:-$DEFAULT_REF}"
ARCHIVE_URL="${ROUTX_ARCHIVE_URL:-}"
DIR=""
ARGS_FILE=""

die() { printf 'Ошибка: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

usage() {
	cat <<'EOF'
RoutX bootstrap installer

Скачивает RoutX в каталог и запускает `routx install`.

  --dir PATH        каталог установки (по умолчанию /opt/routx)
  --ref REF         ветка/тег (по умолчанию main)
  --repo URL        git-репозиторий
  --archive URL     прямая ссылка на tar.gz (если git недоступен)
  --help            эта справка

Остальные параметры передаются в `routx install`, например:
  --docker --domain panel.example.com --tls-email admin@example.com
  --native --db-url postgres://user:pass@127.0.0.1:5432/routx

Переменные окружения: ROUTX_DIR, ROUTX_REPO_URL, ROUTX_REF,
ROUTX_ARCHIVE_URL.
EOF
}

download() {
	__url="$1"
	__out="$2"
	if has curl; then
		curl -fsSL "$__url" -o "$__out"
	elif has wget; then
		wget -qO "$__out" "$__url"
	else
		die "Нужен curl или wget"
	fi
}

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P || pwd)
if [ -f "$SCRIPT_DIR/scripts/routx" ] && [ -f "$SCRIPT_DIR/package.json" ]; then
	LOCAL_DIR="$SCRIPT_DIR"
else
	LOCAL_DIR=""
fi

ARGS_FILE=$(mktemp)
trap 'rm -f "$ARGS_FILE"' 0

while [ $# -gt 0 ]; do
	case "$1" in
		--dir)
			[ $# -ge 2 ] || die "--dir требует путь"
			DIR="$2"
			shift 2
			;;
		--ref)
			[ $# -ge 2 ] || die "--ref требует значение"
			REF="$2"
			shift 2
			;;
		--repo)
			[ $# -ge 2 ] || die "--repo требует значение"
			REPO_URL="$2"
			shift 2
			;;
		--archive)
			[ $# -ge 2 ] || die "--archive требует значение"
			ARCHIVE_URL="$2"
			shift 2
			;;
		--help|-h)
			usage
			exit 0
			;;
		*)
			printf '%s\n' "$1" >> "$ARGS_FILE"
			shift
			;;
	esac
done

if [ -z "$DIR" ]; then
	if [ -n "$LOCAL_DIR" ]; then
		DIR="$LOCAL_DIR"
	else
		DIR="${ROUTX_DIR:-/opt/routx}"
	fi
fi

if [ -z "$ARCHIVE_URL" ]; then
	ARCHIVE_URL="https://gitlab.com/artur.utenkov/router-control/-/archive/$REF/router-control-$REF.tar.gz"
fi

if [ -f "$DIR/package.json" ] && [ -f "$DIR/scripts/routx" ]; then
	:
elif [ -d "$DIR/.git" ]; then
	has git || die "Каталог $DIR уже существует, но git не найден для обновления."
	git -C "$DIR" fetch --depth 1 origin "$REF"
	git -C "$DIR" reset --hard "origin/$REF"
elif has git; then
	mkdir -p "$(dirname "$DIR")"
	git clone --depth 1 --branch "$REF" "$REPO_URL" "$DIR" || {
		printf 'git clone не удался, пробую архив...\n' >&2
		TMP=$(mktemp -d)
		download "$ARCHIVE_URL" "$TMP/src.tar.gz"
		tar -xzf "$TMP/src.tar.gz" -C "$TMP"
		SRC=""
		for item in "$TMP"/*; do
			if [ -d "$item" ]; then SRC="$item"; break; fi
		done
		[ -n "$SRC" ] || die "Не удалось распаковать архив RoutX."
		mkdir -p "$DIR"
		(cd "$SRC" && tar -cf - .) | (cd "$DIR" && tar -xf -)
		rm -rf "$TMP"
	}
else
	TMP=$(mktemp -d)
	download "$ARCHIVE_URL" "$TMP/src.tar.gz"
	tar -xzf "$TMP/src.tar.gz" -C "$TMP"
	SRC=""
	for item in "$TMP"/*; do
		if [ -d "$item" ]; then SRC="$item"; break; fi
	done
	[ -n "$SRC" ] || die "Не удалось распаковать архив RoutX."
	mkdir -p "$DIR"
	(cd "$SRC" && tar -cf - .) | (cd "$DIR" && tar -xf -)
	rm -rf "$TMP"
fi

[ -f "$DIR/scripts/routx" ] || die "В $DIR нет scripts/routx."
[ -f "$DIR/package.json" ] || die "В $DIR нет package.json."

set -- install --dir "$DIR"
while IFS= read -r arg; do
	set -- "$@" "$arg"
done < "$ARGS_FILE"

exec sh "$DIR/scripts/routx" "$@"
