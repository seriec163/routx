#!/bin/sh
# Сборка версионного образа панели.
#
#   ./build-version.sh 2.1.0 /opt/routx-build-2.1.0 3c057a8
#
# Исходники должны быть уже распакованы в <source-dir> (см. docs/runbooks/deploy-image.md).
# Тег образа: routx:<version>.

set -eu

VERSION=${1:-}
SOURCE=${2:-}
GIT_SHA=${3:-dev}

if [ -z "$VERSION" ] || [ -z "$SOURCE" ]; then
  echo "Использование: build-version.sh <version> <source-dir> [git-sha]" >&2
  exit 2
fi

if printf '%s' "$VERSION" | grep -Eqv '^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$'; then
  echo "Версия должна быть вида 2.1.0 (получено: $VERSION)" >&2
  exit 2
fi

if [ ! -f "$SOURCE/Dockerfile" ]; then
  echo "В $SOURCE нет Dockerfile" >&2
  exit 2
fi

if [ -n "$(git -C "$SOURCE" status --porcelain 2>/dev/null || true)" ]; then
  echo "Внимание: исходники не из чистого git-дерева, образ всё равно собирается." >&2
fi

TAG="routx:$VERSION"
echo "Сборка $TAG из $SOURCE (build sha: $GIT_SHA)"
docker build --build-arg RC_BUILD_SHA="$GIT_SHA" -t "$TAG" "$SOURCE"
docker image inspect "$TAG" --format "готово: $TAG {{.Size}}" >/dev/null
echo "Готово: $TAG"
