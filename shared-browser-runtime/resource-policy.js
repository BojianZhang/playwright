'use strict';

/**
 * Shared browser resource policy.
 *
 * Goal:
 * - centralize resource blocking policy for staged runtime
 * - keep route-level interception out of site business entry files
 */

function normalizeBlockedResourceTypes(input = null) {
  return Array.isArray(input)
    ? input.map(item => String(item || '').trim().toLowerCase()).filter(Boolean)
    : ['image', 'media', 'font'];
}

async function applyResourcePolicy(context, blockedResourceTypes = []) {
  const blocked = normalizeBlockedResourceTypes(blockedResourceTypes);
  await context.route('**/*', async route => {
    const request = route.request();
    const resourceType = String(request.resourceType() || '').trim().toLowerCase();
    if (blocked.includes(resourceType)) {
      await route.abort().catch(() => {});
      return;
    }
    await route.continue().catch(() => {});
  });
}

module.exports = {
  normalizeBlockedResourceTypes,
  applyResourcePolicy,
};
