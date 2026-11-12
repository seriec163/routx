import type { Pool } from 'pg';

export type MfaPolicy = 'all' | 'admins';

export interface PlatformSettings {
  mfaPolicy: MfaPolicy;
  sessionDays: number;
  limits: {
    routersPerUser: number;
    usersPerInstance: number;
    routersPerInstance: number;
    batchSize: number;
    templatesPerUser: number;
  };
  monitoring: {
    intervalSeconds: number;
    offlineAfterMisses: number;
    latencyDegradedMs: number;
    staggerSeconds: number;
    degradedAfterSamples: number;
    degradedCooldownMinutes: number;
    recoveryNotify: boolean;
  };
  retention: { days: number; commandsDays: number; snapshotsLocal: number };
  agent: {
    pollHoldSeconds: number;
    commandTtlReadSeconds: number;
    commandTtlMutateSeconds: number;
    minVersion: string;
  };
  singbox: { userInstall: boolean; userCooldownHours: number; stagedRollout: string };
  features: { mtls: boolean; logread: boolean; autoReconcile: boolean; apiTokens: boolean };
}

export const DEFAULT_SETTINGS: PlatformSettings = {
  mfaPolicy: 'all',
  sessionDays: 45,
  limits: {
    routersPerUser: 10,
    usersPerInstance: 20,
    routersPerInstance: 100,
    batchSize: 10,
    templatesPerUser: 50,
  },
  monitoring: {
    intervalSeconds: 60,
    offlineAfterMisses: 3,
    latencyDegradedMs: 1500,
    staggerSeconds: 50,
    degradedAfterSamples: 3,
    degradedCooldownMinutes: 360,
    recoveryNotify: true,
  },
  retention: { days: 30, commandsDays: 7, snapshotsLocal: 10 },
  agent: {
    pollHoldSeconds: 25,
    commandTtlReadSeconds: 120,
    commandTtlMutateSeconds: 600,
    minVersion: '1.0.0',
  },
  singbox: { userInstall: true, userCooldownHours: 24, stagedRollout: 'superadmin' },
  features: { mtls: false, logread: false, autoReconcile: false, apiTokens: false },
};

type SettingValue = Record<string, unknown>;

async function readRaw(pool: Pool, keys: string[]): Promise<Map<string, SettingValue>> {
  const result = await pool.query<{ key: string; value: SettingValue }>(
    'select key, value from settings where key = any($1::text[])',
    [keys],
  );
  return new Map(result.rows.map((row) => [row.key, row.value]));
}

function num(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function loadSettings(pool: Pool): Promise<PlatformSettings> {
  const rows = await readRaw(pool, [
    'security.mfa_policy',
    'security.session_days',
    'limits',
    'monitoring',
    'retention',
    'agent',
    'singbox',
    'features',
  ]);

  const mfa = rows.get('security.mfa_policy')?.value;
  const limits = rows.get('limits') ?? {};
  const monitoring = rows.get('monitoring') ?? {};
  const retention = rows.get('retention') ?? {};
  const agent = rows.get('agent') ?? {};
  const singbox = rows.get('singbox') ?? {};
  const features = rows.get('features') ?? {};

  const mfaPolicy: MfaPolicy = mfa === 'admins' ? 'admins' : 'all';

  return {
    mfaPolicy,
    sessionDays: num(rows.get('security.session_days')?.value, DEFAULT_SETTINGS.sessionDays),
    limits: {
      routersPerUser: num(limits.routers_per_user, DEFAULT_SETTINGS.limits.routersPerUser),
      usersPerInstance: num(limits.users_per_instance, DEFAULT_SETTINGS.limits.usersPerInstance),
      routersPerInstance: num(
        limits.routers_per_instance,
        DEFAULT_SETTINGS.limits.routersPerInstance,
      ),
      batchSize: num(limits.batch_size, DEFAULT_SETTINGS.limits.batchSize),
      templatesPerUser: num(
        limits.templates_per_user,
        DEFAULT_SETTINGS.limits.templatesPerUser,
      ),
    },
    monitoring: {
      intervalSeconds: num(
        monitoring.interval_seconds,
        DEFAULT_SETTINGS.monitoring.intervalSeconds,
      ),
      offlineAfterMisses: num(
        monitoring.offline_after_misses,
        DEFAULT_SETTINGS.monitoring.offlineAfterMisses,
      ),
      latencyDegradedMs: num(
        monitoring.latency_degraded_ms,
        DEFAULT_SETTINGS.monitoring.latencyDegradedMs,
      ),
      staggerSeconds: num(monitoring.stagger_seconds, DEFAULT_SETTINGS.monitoring.staggerSeconds),
      degradedAfterSamples: num(
        monitoring.degraded_after_samples,
        DEFAULT_SETTINGS.monitoring.degradedAfterSamples,
      ),
      degradedCooldownMinutes: num(
        monitoring.degraded_cooldown_minutes,
        DEFAULT_SETTINGS.monitoring.degradedCooldownMinutes,
      ),
      recoveryNotify:
        typeof monitoring.recovery_notify === 'boolean'
          ? monitoring.recovery_notify
          : DEFAULT_SETTINGS.monitoring.recoveryNotify,
    },
    retention: {
      days: num(retention.days, DEFAULT_SETTINGS.retention.days),
      commandsDays: num(retention.commands_days, DEFAULT_SETTINGS.retention.commandsDays),
      snapshotsLocal: num(retention.snapshots_local, DEFAULT_SETTINGS.retention.snapshotsLocal),
    },
    agent: {
      pollHoldSeconds: num(agent.poll_hold_seconds, DEFAULT_SETTINGS.agent.pollHoldSeconds),
      commandTtlReadSeconds: num(
        agent.command_ttl_read_seconds,
        DEFAULT_SETTINGS.agent.commandTtlReadSeconds,
      ),
      commandTtlMutateSeconds: num(
        agent.command_ttl_mutate_seconds,
        DEFAULT_SETTINGS.agent.commandTtlMutateSeconds,
      ),
      minVersion:
        typeof agent.min_version === 'string'
          ? agent.min_version
          : DEFAULT_SETTINGS.agent.minVersion,
    },
    singbox: {
      userInstall:
        typeof singbox.user_install === 'boolean'
          ? singbox.user_install
          : DEFAULT_SETTINGS.singbox.userInstall,
      userCooldownHours: num(
        singbox.user_cooldown_hours,
        DEFAULT_SETTINGS.singbox.userCooldownHours,
      ),
      stagedRollout:
        typeof singbox.staged_rollout === 'string'
          ? singbox.staged_rollout
          : DEFAULT_SETTINGS.singbox.stagedRollout,
    },
    features: {
      mtls: features.mtls === true,
      logread: features.logread === true,
      autoReconcile: features.auto_reconcile === true,
      apiTokens: features.api_tokens === true,
    },
  };
}

export async function updateSetting(
  pool: Pool,
  key: string,
  value: SettingValue,
  userId: string,
): Promise<void> {
  await pool.query(
    `insert into settings (key, value, updated_by, updated_at)
     values ($1, $2::jsonb, $3, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), userId],
  );
}
