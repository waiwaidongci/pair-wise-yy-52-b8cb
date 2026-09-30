import { d as defineEventHandler } from '../../nitro/nitro.mjs';
import 'node:http';
import 'node:https';
import 'node:events';
import 'node:buffer';
import 'node:fs';
import 'node:path';
import 'node:crypto';
import 'node:url';
import '@iconify/utils';
import 'consola';

const operations_get = defineEventHandler(() => ({
  site: "\u6D77\u5DDE\u6E7E H2 \u98CE\u7535\u573A",
  generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
  onlineDevices: 30,
  totalDevices: 32,
  windSpeed: 10.8,
  revision: 12
}));

export { operations_get as default };
//# sourceMappingURL=operations.get.mjs.map
