import type { JobRow } from './queue.js';
import type { HandlerContext, Json } from './helpers.js';
import { wifiCreate, wifiDelete, wifiRead, wifiUpdate } from './handlers/wifi.js';
import {
  agentUpdate,
  componentCheck,
  componentUpdate,
} from './handlers/agent.js';
import {
  accessCheck,
  diagnostics,
  rebootRouter,
  restoreSnapshot,
  serviceAction,
  siteCheck,
  snapshot,
} from './handlers/operations.js';
import { monitorProbe } from './handlers/monitor.js';
import {
  applyRun,
  diffCustom,
  diffPodkop,
  diffTemplate,
  podkopOutbound,
  proxySelect,
  refreshState,
} from './handlers/apply.js';
import {
  applyRouterConnections,
  listConnections,
  manageConnection,
  readRules,
  sectionDelete,
} from './handlers/connections.js';
import { singBoxCheck, singBoxInstall } from './handlers/singbox.js';
import {
  bulkUpdate,
  dnsBenchmark,
  productSwitch,
  reconcile,
  removePackages,
} from './handlers/products.js';
export { proxyHealthOf } from './handlers/monitor.js';
export { JobFailure } from './errors.js';
export type { HandlerContext } from './helpers.js';

export type JobHandler = (ctx: HandlerContext, job: JobRow) => Promise<Json>;

export const HANDLERS: Record<string, JobHandler> = {
  refresh_state: refreshState,
  diff: diffTemplate,
  diff_custom: diffCustom,
  diff_podkop: diffPodkop,
  podkop_outbound: podkopOutbound,
  proxy_select: proxySelect,
  apply: applyRun,
  read_rules: readRules,
  monitor: monitorProbe,
  access_check: accessCheck,
  site_check: siteCheck,
  agent_update: agentUpdate,
  product_switch: productSwitch,
  remove_packages: removePackages,
  diagnostics,
  snapshot,
  restore: restoreSnapshot,
  sb_check: singBoxCheck,
  sb_install: singBoxInstall,
  service_action: serviceAction,
  reboot: rebootRouter,
  component_check: componentCheck,
  component_update: componentUpdate,
  bulk_update: bulkUpdate,
  wifi_read: wifiRead,
  wifi_update: wifiUpdate,
  wifi_create: wifiCreate,
  wifi_delete: wifiDelete,
  dns_benchmark: dnsBenchmark,
  connections_apply: applyRouterConnections,
  list_connections: listConnections,
  manage_connection: manageConnection,
  section_delete: sectionDelete,
  reconcile,
};
