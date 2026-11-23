-- Зеркало установщиков и пакетов роутеров на сервере панели.
--
-- files лежат в dataDir/packages, в БД — метаданные и SHA-256. Зеркало
-- наполняется последними релизами GitHub для архитектуры aarch64_cortex-a53;
-- если GitHub недоступен, панель отдаёт уже сохранённые файлы.

create table if not exists package_mirror (
  id           uuid primary key,
  product      text not null,
  repo         text not null,
  kind         text not null check (kind in ('installer', 'asset', 'release_json', 'raw')),
  name         text not null,
  tag          text not null,
  source_url   text not null,
  storage_path text not null,
  sha256       text not null,
  size_bytes   bigint not null,
  metadata     jsonb not null default '{}'::jsonb,
  fetched_at   timestamptz not null default now(),
  constraint package_mirror_unique unique (repo, kind, name, tag)
);

create index if not exists package_mirror_product_idx
  on package_mirror (product, fetched_at desc);

create index if not exists package_mirror_repo_idx
  on package_mirror (repo, tag);
